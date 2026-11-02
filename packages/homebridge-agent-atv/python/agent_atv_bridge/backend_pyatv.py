"""PyatvBackend(pyatv_module): the only code that touches pyatv, and only through that module object."""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import socket
from typing import Any, Awaitable, Callable, Dict, Iterator, Optional, TypeVar

from .errors import BridgeError, exception_classes, map_exception
from .pairing import PairingSessions
from .keys import INPUT_ACTIONS, KEYS_WITH_ACTION
from .publisher import StatePublisher, Timings
from .state import build_state, device_id, device_summary, feature_unavailable, keyboard_focus, power_state, scan_device

_LOGGER = logging.getLogger("agent_atv_bridge.pyatv")

Emit = Callable[[str, Optional[str], Dict[str, Any]], None]
T = TypeVar("T")


class _Listener:
    """One object for every pyatv listener interface; pyatv only keeps a weak reference to it."""

    def __init__(self, connection: "_Connection") -> None:
        self._connection = connection

    def playstatus_update(self, updater: Any, playstatus: Any) -> None:
        self._connection.playing = playstatus
        self._connection.publisher.notify()

    def playstatus_error(self, updater: Any, exception: Exception) -> None:
        _LOGGER.warning("%s: push update failed: %s", self._connection.device, exception)
        self._connection.publisher.notify()

    def powerstate_update(self, old_state: Any, new_state: Any) -> None:
        self._connection.power_changed.set()
        self._connection.publisher.notify()

    def volume_update(self, old_level: float, new_level: float) -> None:
        self._connection.publisher.notify()

    def volume_device_update(self, output_device: Any, old_level: float, new_level: float) -> None:
        pass

    def outputdevices_update(self, old_devices: Any, new_devices: Any) -> None:
        pass

    def focusstate_update(self, old_state: Any, new_state: Any) -> None:
        self._connection.focus_changed()

    def connection_lost(self, exception: Exception) -> None:
        self._connection.dropped("connection_lost", str(exception) or type(exception).__name__)

    def connection_closed(self) -> None:
        self._connection.dropped("connection_closed", "Connection closed by the Apple TV")


class _Connection:
    def __init__(
        self,
        device: str,
        atv: Any,
        config: Any,
        protocols: Dict[str, bool],
        *,
        const: Any,
        exceptions: Any,
        timings: Timings,
        emit: Emit,
        on_dropped: Callable[["_Connection"], bool],
    ) -> None:
        self.device = device
        self.atv = atv
        self.summary = device_summary(config, atv.device_info)
        self.protocols = protocols
        self.playing: Any = None
        self.keyboard_text: Optional[str] = None
        self._const = const
        self._exceptions = exceptions
        self._timings = timings
        self._emit = emit
        self._on_dropped = on_dropped
        self.publisher = StatePublisher(self.state, lambda state: emit("state", device, state), timings)
        self.listener = _Listener(self)
        self.tasks: set = set()
        self.power_changed = asyncio.Event()
        self.probe_supported = True
        self._companion: Any = None
        self.power_commands = 0
        self.power_commands_started = 0
        self._session_check: Optional[asyncio.Task] = None

    def state(self) -> Dict[str, Any]:
        volume_available = not feature_unavailable(self.atv, self._const, "Volume")
        return build_state(self.atv, self.summary, self.protocols, self.playing, self.keyboard_text, volume_available)

    async def wait_for_power(self, target: str, timeout_s: float) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout_s
        while power_state(self.atv) != target:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return False
            self.power_changed.clear()
            try:
                await asyncio.wait_for(self.power_changed.wait(), remaining)
            except asyncio.TimeoutError:
                pass
        return True

    async def probe(self, grace_s: float = 0, current: Callable[[], bool] = lambda: True) -> Optional[str]:
        """The power the Apple TV reports when asked (not pushed); None without an answer.

        pyatv can keep a session whose pushed updates stopped while its sockets stay up, so the
        session is dropped (and the plugin reconnects) when the answer is missing or disagrees.
        A result for which `current()` turned false, a power command having overtaken it, is ignored.
        """
        if not self.probe_supported:
            return None
        timeout_s = self._timings.probe_timeout_s
        try:
            probed = await asyncio.wait_for(_attention_power(self._companion), timeout_s)
        except Exception as exc:
            if _refused(exc, self._exceptions):
                if self.probe_supported:
                    _LOGGER.warning("%s: cannot check the session for missed updates: %s", self.device, exc)
                self.probe_supported = False
            elif current():
                failure = f"no answer within {timeout_s:g} s" if _is_timeout(exc) else f"failed: {exc}"
                self.stale(f"FetchAttentionState {failure}")
            return None
        if probed != power_state(self.atv) and grace_s:
            await asyncio.sleep(grace_s)
        session = power_state(self.atv)
        _LOGGER.debug("%s: session check: the Apple TV says power %s, the session %s", self.device, probed, session)
        if probed != "unknown" and probed != session and current():
            self.stale(f"the Apple TV says power {probed} but the session still says {session}")
        return probed

    async def _check_session_periodically(self) -> None:
        while self.probe_supported:
            await asyncio.sleep(self._timings.probe_interval_s)
            if self.power_commands:
                continue
            commands_before = self.power_commands_started
            await self.probe(self._timings.probe_grace_s, current=lambda: self.power_commands_started == commands_before)

    @contextlib.contextmanager
    def power_command(self) -> Iterator[None]:
        self.power_commands += 1
        self.power_commands_started += 1
        try:
            yield
        finally:
            self.power_commands -= 1

    def stale(self, why: str) -> None:
        _LOGGER.warning("%s: pushed updates stopped (%s); reconnecting", self.device, why)
        self.dropped("stale_session", why)

    def _spawn(self, call: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(call)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def focus_changed(self) -> None:
        self._spawn(self.refresh_keyboard())

    async def refresh_keyboard(self) -> None:
        if keyboard_focus(self.atv) == "focused":
            try:
                self.keyboard_text = await asyncio.wait_for(self.atv.keyboard.text_get(), self._timings.call_timeout_s)
            except Exception as exc:
                _LOGGER.warning("%s: could not read the keyboard text: %s", self.device, exc)
        else:
            self.keyboard_text = None
        self.publisher.notify()

    def dropped(self, reason: str, message: str) -> None:
        if not self._on_dropped(self):
            return
        self._emit("connection", self.device, {"status": "disconnected", "reason": reason, "message": message})
        self._spawn(self.close())

    def _attach(self, listener: Any) -> None:
        self.atv.listener = listener
        self.atv.push_updater.listener = listener
        for producer in (self.atv.power, self.atv.audio, self.atv.keyboard):
            try:
                producer.listener = listener
            except Exception as exc:
                _LOGGER.debug("%s: no listener for %s: %s", self.device, type(producer).__name__, exc)

    async def start(self) -> None:
        self._attach(self.listener)
        self.atv.push_updater.start()
        try:
            self.playing = await asyncio.wait_for(self.atv.metadata.playing(), self._timings.call_timeout_s)
        except Exception as exc:
            _LOGGER.warning("%s: could not read what is playing: %s", self.device, exc)
        if keyboard_focus(self.atv) == "focused":
            await self.refresh_keyboard()
        self.publisher.start()
        try:
            self._companion = _companion_api(self.atv, self._const)
        except (AttributeError, KeyError) as exc:
            _LOGGER.warning(
                "%s: cannot check the session for missed updates (this pyatv has no Companion power API: %r); "
                "update homebridge-agent-atv", self.device, exc,
            )
            self.probe_supported = False
            return
        self._session_check = asyncio.ensure_future(self._check_session_periodically())

    async def close(self) -> None:
        if self._session_check is not None:
            self._session_check.cancel()
        self.publisher.stop()
        try:
            self.atv.push_updater.stop()
        except Exception:
            pass
        self._attach(None)
        await _close_atv(self.atv)


def _is_apple_tv(device: Dict[str, Any]) -> bool:
    """pyatv labels HomePods tvOS too; they have a HomePod model or a Companion service that can't pair."""
    if device["os"] != "tvOS" or "homepod" in (device["model"] or "").lower():
        return False
    return not any(s["protocol"] == "companion" and s["pairing"] == "unsupported" for s in device["services"])


class PyatvBackend:
    name = "pyatv"

    def __init__(self, pyatv_module: Any, *, timings: Timings = Timings()) -> None:
        self._pyatv = pyatv_module
        self._timings = timings
        self._emit: Emit = lambda *_: None
        self.pyatv_version: Optional[str] = getattr(pyatv_module.const, "__version__", None)
        self._connections: Dict[str, _Connection] = {}
        self._connecting: Dict[str, asyncio.Lock] = {}
        self._pairings = PairingSessions(timings.pairing_ttl_s)

    def bind(self, emit: Emit) -> None:
        self._emit = emit

    async def scan(self, params: Dict[str, Any]) -> Dict[str, Any]:
        timeout_s = params.get("timeoutMs", 5000) / 1000
        hosts = params.get("hosts")
        if hosts:
            hosts = [host for host in [await _ipv4(host) for host in hosts] if host]
            if not hosts:
                return {"devices": []}
        configs = await self._guard(
            self._pyatv.scan(asyncio.get_running_loop(), timeout=timeout_s, hosts=hosts or None),
            timeout_s=timeout_s + 5,
        )
        devices = [scan_device(config) for config in configs]
        return {"devices": [device for device in devices if _is_apple_tv(device)]}

    async def _find(self, device: str, address: Optional[str], timeout_s: float = 5) -> Any:
        """Unicast scan of the known address first, then multicast: the address may be stale (DHCP)."""
        host = await _ipv4(address) if address else None
        for hosts in ([host], None) if host else (None,):
            configs = await self._pyatv.scan(asyncio.get_running_loop(), timeout=timeout_s, identifier=device, hosts=hosts)
            for config in configs:
                if device_id(config).upper() == device.upper() or device in config.all_identifiers:
                    return config
        raise BridgeError("DEVICE_NOT_FOUND", f"Device {device} was not found", {"device": device})

    def _protocol(self, name: str) -> Any:
        Protocol = self._pyatv.const.Protocol
        return Protocol.Companion if name == "companion" else Protocol.AirPlay

    async def pair_begin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        device = params["device"].upper()
        self._pairings.ensure_none_active(device)
        config = await self._guard(self._find(params["device"], params.get("address")), timeout_s=self._timings.connect_timeout_s)
        handler = await self._guard(
            self._pyatv.pair(config, self._protocol(params["protocol"]), asyncio.get_running_loop(), name=params["remoteName"])
        )
        try:
            await asyncio.wait_for(handler.begin(), self._timings.connect_timeout_s)
        except Exception as exc:
            await _close_quietly(handler)
            raise map_exception(exc, self._pyatv.exceptions) from exc
        try:
            # Another pair.begin for this device may have won the race while we awaited pyatv.
            self._pairings.ensure_none_active(device)
        except BridgeError:
            await _close_quietly(handler)
            raise
        session = self._pairings.add(device, params["protocol"], handler, handler.close)
        return {"pairingId": session.pairing_id, "protocol": session.protocol, "deviceProvidesPin": bool(handler.device_provides_pin)}

    async def pair_pin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session = self._pairings.take(params["pairingId"])
        handler = session.handler
        try:
            handler.pin(int(params["pin"]))
            await asyncio.wait_for(handler.finish(), self._timings.connect_timeout_s)
            if not handler.has_paired:
                raise BridgeError("PAIRING_FAILED", "The Apple TV did not accept the PIN")
            return {"protocol": session.protocol, "credentials": handler.service.credentials}
        except Exception as exc:
            raise map_exception(exc, self._pyatv.exceptions) from exc
        finally:
            await _close_quietly(handler)

    async def pair_cancel(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self._pairings.cancel(params["pairingId"])
        return {}

    async def pair_verify(self, params: Dict[str, Any]) -> Dict[str, Any]:
        config = await self._guard(self._find(params["device"], params.get("address")), timeout_s=self._timings.connect_timeout_s)
        protocol = self._protocol(params["protocol"])
        config.set_credentials(protocol, params["credentials"])
        for service in config.services:
            if service.protocol != protocol:
                service.enabled = False
        rejected = exception_classes(self._pyatv.exceptions, "AuthenticationError", "InvalidCredentialsError", "ConnectionFailedError")
        atv = None
        try:
            atv = await asyncio.wait_for(self._pyatv.connect(config, asyncio.get_running_loop()), self._timings.connect_timeout_s)
            await asyncio.wait_for(atv.metadata.playing(), self._timings.call_timeout_s)
            return {"valid": True}
        except Exception as exc:
            if isinstance(exc, rejected):
                return {"valid": False}
            raise map_exception(exc, self._pyatv.exceptions, secrets=[params["credentials"]]) from exc
        finally:
            if atv is not None:
                await _close_atv(atv)

    async def connect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        device = params["device"].upper()
        async with self._connecting.setdefault(device, asyncio.Lock()):
            existing = self._connections.get(device)
            if existing is not None:
                return existing.state()
            config = await self._guard(self._find(params["device"], params.get("address")), timeout_s=self._timings.connect_timeout_s)
            credentials = params["credentials"]
            Protocol = self._pyatv.const.Protocol
            config.set_credentials(Protocol.Companion, credentials["companion"])
            if credentials.get("airplay"):
                config.set_credentials(Protocol.AirPlay, credentials["airplay"])
            secrets = [value for value in credentials.values() if value]
            try:
                atv = await asyncio.wait_for(self._pyatv.connect(config, asyncio.get_running_loop()), self._timings.connect_timeout_s)
            except Exception as exc:
                raise map_exception(exc, self._pyatv.exceptions, during_connect=True, secrets=secrets) from exc
            protocols = {"companion": True, "airplay": bool(credentials.get("airplay"))}
            connection = _Connection(
                device,
                atv,
                config,
                protocols,
                const=self._pyatv.const,
                exceptions=self._pyatv.exceptions,
                timings=self._timings,
                emit=lambda *event: self._emit(*event),
                on_dropped=self._forget_connection,
            )
            try:
                await connection.start()
            except Exception as exc:
                await connection.close()
                raise map_exception(exc, self._pyatv.exceptions, during_connect=True, secrets=secrets) from exc
            self._connections[device] = connection
            return connection.state()

    def _forget_connection(self, connection: _Connection) -> bool:
        """Removes a dropped connection; false when it was already replaced or closed."""
        if self._connections.get(connection.device) is not connection:
            return False
        del self._connections[connection.device]
        return True

    async def _guard(self, call: Awaitable[T], feature: Optional[str] = None, timeout_s: Optional[float] = None) -> T:
        try:
            return await asyncio.wait_for(call, timeout_s or self._timings.call_timeout_s)
        except Exception as exc:
            raise map_exception(exc, self._pyatv.exceptions, feature=feature) from exc

    def _connection(self, device: str) -> _Connection:
        connection = self._connections.get(device.upper())
        if connection is None:
            raise BridgeError("NOT_CONNECTED", f"Device {device} is not connected", {"device": device})
        return connection

    async def disconnect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connections.pop(params["device"].upper(), None)
        if connection is not None:
            await connection.close()
        return {}

    async def state(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        if params.get("refresh"):
            connection.playing = await self._guard(connection.atv.metadata.playing())
            await connection.refresh_keyboard()
        return connection.state()

    async def apps_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        apps = await self._guard(connection.atv.apps.app_list(), feature="AppList")
        listed = [{"bundleId": app.identifier, "name": app.name or app.identifier} for app in apps]
        return {"apps": sorted(listed, key=lambda app: app["name"].lower())}

    async def app_launch(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        target = params["target"]
        try:
            await asyncio.wait_for(connection.atv.apps.launch_app(target), self._timings.call_timeout_s)
        except asyncio.TimeoutError as exc:
            raise map_exception(exc, self._pyatv.exceptions) from exc
        except Exception as exc:
            raise BridgeError("LAUNCH_FAILED", f"Could not launch {target}: {exc}", {"target": target}) from exc
        connection.publisher.notify()
        return {}

    async def power_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        with connection.power_command():
            return await self._set_power(connection, params["on"])

    async def _set_power(self, connection: _Connection, on: bool) -> Dict[str, Any]:
        power = connection.atv.power
        # Companion raises NotImplementedError for await_new_state=True, so the bridge waits itself.
        if on:
            target, wait_s = "on", self._timings.power_on_wait_s
            await self._guard(power.turn_on(await_new_state=False), feature="TurnOn")
        else:
            target, wait_s = "off", self._timings.power_off_wait_s
            await self._guard(power.turn_off(await_new_state=False), feature="TurnOff")
        if not await connection.wait_for_power(target, wait_s):
            if await connection.probe() != target:
                current = power_state(connection.atv)
                raise BridgeError(
                    "POWER_NOT_CONFIRMED",
                    f"{connection.summary['name']} still reports power {current} {wait_s:g} s after power {target}",
                    {"requested": target, "power": current},
                )
            if self._connections.get(connection.device) is not connection:
                # The probe dropped the stale session; the reconnect publishes the state.
                return {"power": target}
        connection.publisher.notify()
        return {"power": target}

    async def volume_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        await self._guard(connection.atv.audio.set_volume(params["level"]), feature="SetVolume")
        connection.publisher.notify()
        return {"volume": connection.state()["volume"]}

    async def seek(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        await self._guard(connection.atv.remote_control.set_position(params["position"]), feature="SetPosition")
        return {}

    def _keyboard(self, connection: _Connection) -> Dict[str, Any]:
        return connection.state()["keyboard"]

    async def keyboard_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._keyboard(self._connection(params["device"]))

    async def _edit_keyboard(self, params: Dict[str, Any], edit: Callable[[Any], Awaitable[None]], feature: str) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        if keyboard_focus(connection.atv) != "focused":
            raise BridgeError("KEYBOARD_NOT_FOCUSED", f"No text field is focused on {connection.summary['name']}")
        await self._guard(edit(connection.atv.keyboard), feature=feature)
        await connection.refresh_keyboard()
        return self._keyboard(connection)

    async def keyboard_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self._edit_keyboard(params, lambda keyboard: keyboard.text_set(params["text"]), "TextSet")

    async def keyboard_append(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self._edit_keyboard(params, lambda keyboard: keyboard.text_append(params["text"]), "TextAppend")

    async def keyboard_clear(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self._edit_keyboard(params, lambda keyboard: keyboard.text_clear(), "TextClear")

    async def key(self, params: Dict[str, Any]) -> Dict[str, Any]:
        connection = self._connection(params["device"])
        key = params["key"]
        press = getattr(connection.atv.remote_control, key)
        if key in KEYS_WITH_ACTION:
            action = getattr(self._pyatv.const.InputAction, INPUT_ACTIONS[params.get("action") or "tap"])
            await self._guard(press(action=action), feature=key)
        else:
            await self._guard(press(), feature=key)
        return {}

    async def close(self) -> None:
        await self._pairings.close_all()
        for device in list(self._connections):
            await self._connections.pop(device).close()


def _companion_api(atv: Any, const: Any) -> Any:
    """pyatv 0.18 only exposes Companion FetchAttentionState on its private Companion power object."""
    return atv.power._interfaces[const.Protocol.Companion].api


async def _attention_power(companion: Any) -> str:
    status = await companion.fetch_attention_state()
    if status.name == "Asleep":
        return "off"
    return "on" if status.name in ("Awake", "Idle", "Screensaver") else "unknown"


def _refused(exc: BaseException, exceptions: Any) -> bool:
    """The Apple TV answered without a state: pyatv raises ProtocolError without a cause."""
    protocol_error = exception_classes(exceptions, "ProtocolError")
    return bool(protocol_error) and isinstance(exc, protocol_error) and exc.__cause__ is None


def _is_timeout(exc: BaseException) -> bool:
    """pyatv wraps its own Companion request timeout in a ProtocolError."""
    timeouts = (asyncio.TimeoutError, TimeoutError)
    return isinstance(exc, timeouts) or isinstance(exc.__cause__, timeouts)


async def _ipv4(address: str) -> Optional[str]:
    """pyatv's unicast scan takes IPv4 literals only; host names are resolved, unresolvable ones skipped."""
    try:
        return str(ipaddress.IPv4Address(address))
    except ValueError:
        pass
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(address, None, family=socket.AF_INET)
    except OSError as exc:
        _LOGGER.warning("Cannot resolve %s, scanning by multicast instead: %s", address, exc)
        return None
    return str(infos[0][4][0]) if infos else None


async def _close_quietly(handler: Any) -> None:
    try:
        await handler.close()
    except Exception as exc:
        _LOGGER.debug("Closing a pairing handler failed: %s", exc)


async def _close_atv(atv: Any) -> None:
    try:
        tasks = atv.close()
        if tasks:
            await asyncio.wait(tasks, timeout=3)
    except Exception as exc:
        _LOGGER.debug("Closing a connection failed: %s", exc)
