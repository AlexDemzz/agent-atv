"""Pmd3Backend: the screen worker's only code that touches pymobiledevice3 (DESIGN.md §6).

It holds one no-root userspace tunnel to one Apple TV over Wi-Fi RemotePairing, reconnects it
after failures, reads the focused accessibility element, reads the foreground app and captures
screenshots over DVT, and runs the RemotePairing PIN pairing.
"""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from agent_atv_bridge.errors import BridgeError

from . import image, inbound_queue

_LOGGER = logging.getLogger("agent_atv_screen.pmd3")

# HDR 4K PNGs reach about 33 MB, over pymobiledevice3's 30 MiB DTX reassembly limit.
DTX_MAX_BUFFERED = 128 * 1024 * 1024
FOCUS_ATTRIBUTES = ["Label", "Value", "Identifier"]
# With this monitored event type, a session that called deviceDidGetTargeted gets
# FOCUS_CHANGED for every tvOS focus move; the daemon has no call that returns the focus.
FOLLOW_FOCUS = 2
FOCUS_CHANGED = "hostInspectorCurrentElementChanged:"
MONITORED_TYPE_CHANGED = "hostInspectorMonitoredEventTypeChanged:"
NOTIFICATION = "hostInspectorNotificationReceived:"
# A screen can change without a focus event, leaving the last focused element stale.
SCREEN_CHANGE = "UIAccessibilityScreenChangedNotification"
# So can a layout, unless the daemon then names the same element (PROPERTIES_CHANGED).
LAYOUT_CHANGE = "UIAccessibilityLayoutChangedNotification"
# After a layout change the daemon names the element it still inspects, the focused one.
PROPERTIES_CHANGED = "hostInspectorCurrentElementPropertiesChanged:"
# Bounds the inspector reset of a session being dropped, often over a dead tunnel.
INSPECTOR_RESET_S = 2.0
NOT_FOLLOWED = "The focused element is not known yet: the Apple TV reports it only when the focus moves"
SCREEN_CHANGED = "The screen changed after the focus last moved: the focused element is known again once it moves"
LAYOUT_CHANGED = (
    "The screen's layout changed after the focus last moved: the focused element is known again once it moves"
    " or the Apple TV confirms it"
)
# Foreground in every state measured on tvOS 27.2: the shell and its system UI, never the answer;
# AccessibilityUIServer joins them for 20 s and more once the inspector has highlighted a focus move.
SHELL = {"com.apple.PineBoard", "com.apple.TVSystemUIService", "com.apple.AccessibilityUIServer"}
HOME_SCREEN = "com.apple.HeadBoard"
SCREENSAVER = "com.apple.IdleScreen"
PAIRING_SCREEN = "Settings > Remotes and Devices > Remote App and Devices"


@dataclass(frozen=True)
class Timings:
    retry_s: Tuple[float, ...] = (2, 4, 8, 16, 30, 60)
    health_s: float = 5.0
    call_timeout_s: float = 20.0
    connect_timeout_s: float = 30.0
    browse_s: float = 20.0
    pin_timeout_s: float = 120.0
    session_close_s: float = 1.0
    # How long the session may stay untargeted after the Apple TV ends one lost before it (§6.1 One target).
    retarget_s: float = 30.0


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    text = value if isinstance(value, str) else str(value)
    return text or None


def _describe(exc: BaseException) -> str:
    text = str(exc)
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _first(data: Any) -> Any:
    return data[0] if isinstance(data, list) and data else data


def _same_element(a: Any, b: Any) -> bool:
    return a is not None and b is not None and a.identifier == b.identifier


def _record_identifier(path: Path) -> str:
    return path.name.split("remote_", 1)[1].split(".", 1)[0]


def _bare_ip(hostname: str) -> str:
    return hostname.split("%", 1)[0]


def _foreground(processes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What tvOS shows, from DVT runningProcesses' foregroundRunning flags (DESIGN.md §6.1)."""
    shown = {
        p["bundleIdentifier"]: _text(p.get("displayLocalizedAppName")) or _text(p.get("name")) or p["bundleIdentifier"]
        for p in processes
        if p.get("foregroundRunning") and p.get("bundleIdentifier") and p["bundleIdentifier"] not in SHELL
    }
    if SCREENSAVER in shown:
        return {"kind": "screensaver"}
    # A launching app shares the foreground with the home screen for about a second.
    apps = [{"bundleId": bundle_id, "name": name} for bundle_id, name in sorted(shown.items()) if bundle_id != HOME_SCREEN]
    if len(apps) == 1:
        return {"kind": "app", **apps[0]}
    if apps:
        return {"kind": "ambiguous", "apps": apps}
    if HOME_SCREEN in shown:
        return {"kind": "home"}
    raise BridgeError("SCREEN_FAILED", "The Apple TV reported no app in the foreground")


def _focus_unknown(message: str) -> BridgeError:
    return BridgeError("FOCUS_UNKNOWN", message)


class _NoRecordHere(Exception):
    """Pair records exist, but none for the Apple TV at the worker's address."""


# The pairing a pairing thread runs, so its input() call reaches that pairing and no later one.
_THREAD = threading.local()


class _Pairing:
    """One RemotePairing PIN pairing, run on its own thread and event loop.

    pymobiledevice3 asks for the Apple TV PIN with a blocking input() inside the pairing coroutine.
    Running it on a thread lets that call block until the plugin sends the PIN with pair.pin.
    """

    def __init__(self, pmd3: Any, identifier: str, host: str, port: int, pin_timeout_s: float) -> None:
        self.identifier = identifier
        self._pmd3 = pmd3
        self._host = host
        self._port = port
        self._pin_timeout_s = pin_timeout_s
        self._pins: "queue.Queue[Optional[str]]" = queue.Queue()
        self._loop = asyncio.get_running_loop()
        self.pin_requested: asyncio.Future = self._loop.create_future()
        self.done: asyncio.Future = self._loop.create_future()
        # A cancelled pairing ends in an exception nobody awaits.
        self.done.add_done_callback(lambda future: future.cancelled() or future.exception())

    def start(self) -> None:
        threading.Thread(target=self._run, name="remotepairing", daemon=True).start()

    def read_pin(self, prompt: str = "") -> str:
        self._loop.call_soon_threadsafe(lambda: self.pin_requested.done() or self.pin_requested.set_result(None))
        try:
            pin = self._pins.get(timeout=self._pin_timeout_s)
        except queue.Empty:
            pin = None
        if pin is None:
            raise self._pmd3.exceptions.PairingError("The pairing was cancelled or no PIN arrived")
        return pin

    def send_pin(self, pin: Optional[str]) -> None:
        self._pins.put(pin)

    def _run(self) -> None:
        _THREAD.pairing = self
        outcome: Optional[BaseException] = None
        try:
            asyncio.run(self._pair())
        except BaseException as exc:  # reported to the worker's loop
            outcome = exc
        self._loop.call_soon_threadsafe(self._finish, outcome)

    def _finish(self, outcome: Optional[BaseException]) -> None:
        if self.done.done():
            return
        if outcome is None:
            self.done.set_result(None)
        else:
            self.done.set_exception(outcome)

    async def _pair(self) -> None:
        service = self._pmd3.tunnel_service.RemotePairingManualPairingService(self.identifier, self._host, self._port)
        try:
            await service.connect(autopair=True)
        except self._pmd3.exceptions.RemotePairingCompletedError:
            # The Apple TV closes the connection once pairing is done; the record is already saved.
            pass
        finally:
            await service.close()


class Pmd3Backend:
    name = "pmd3"

    def __init__(self, pmd3: Any, *, address: Optional[str], identifier: Optional[str], timings: Timings = Timings()) -> None:
        self._pmd3 = pmd3
        self._address = address or None
        self._identifier = identifier or None
        self._timings = timings
        self.pmd3_version = pmd3.version
        self._emit: Callable[[str, Dict[str, Any]], None] = lambda name, data: None
        self._tunnel: Any = None
        self._endpoint: Optional[Tuple[str, int]] = None
        self._state = "unpaired"
        self._error: Optional[str] = None
        self._last_status: Optional[Dict[str, Any]] = None
        self._closed = False
        self._supervisor: Optional[asyncio.Task] = None
        self._wake: Optional[asyncio.Event] = None
        self._attempt_finished: Optional[asyncio.Event] = None
        self._capture_lock: Optional[asyncio.Lock] = None
        self._foreground_lock: Optional[asyncio.Lock] = None
        self._focus_lock: Optional[asyncio.Lock] = None
        self._ax_lock: Optional[asyncio.Lock] = None
        self._pairing: Optional[_Pairing] = None
        self._ax: Any = None
        self._ax_rsd: Any = None
        self._follower: Optional[asyncio.Task] = None
        # A session closed on the current tunnel, whose close the tunnel must still deliver.
        self._session_closed = False
        # A session the Apple TV may still end later, untargeting ours: one lost with an earlier
        # tunnel (any tunnel dropped after a session, as a failing one may not deliver its close), or a
        # killed worker's, which a starting worker cannot rule out.
        self._lost_session_pending = True
        self._retarget: Optional[asyncio.Task] = None
        self._follow_failing = False
        # Why the focused element is not known, or None once tvOS reported a move.
        self._unknown: Optional[str] = NOT_FOLLOWED
        self._focused: Any = None
        self._moved_at = 0.0

    # --- lifecycle -------------------------------------------------------------------------

    def bind(self, emit: Callable[[str, Dict[str, Any]], None]) -> None:
        self._emit = emit

    async def start(self) -> None:
        self._wake = asyncio.Event()
        self._attempt_finished = asyncio.Event()
        self._capture_lock = asyncio.Lock()
        self._foreground_lock = asyncio.Lock()
        self._focus_lock = asyncio.Lock()
        self._ax_lock = asyncio.Lock()
        reader = self._pmd3.dtx_reader
        reader.MAX_BUFFERED_SIZE = max(reader.MAX_BUFFERED_SIZE, DTX_MAX_BUFFERED)
        inbound_queue.install(self._pmd3.userspace_tunnel)
        # The stock no-root provider always starts with usbmux, which an Apple TV (Wi-Fi only) never reaches.
        self._pmd3.userspace_tunnel._create_no_root_tunnel_provider = self._provider
        self._pmd3.tunnel_service.input = self._read_pin
        self._set("connecting" if self._has_record() else "unpaired")
        self._supervisor = asyncio.ensure_future(self._supervise())

    async def close(self) -> None:
        self._closed = True
        if self._pairing is not None:
            self._pairing.send_pin(None)
            self._pairing = None
        if self._supervisor is not None:
            self._supervisor.cancel()
        await self._drop_tunnel()

    def status(self) -> Dict[str, Any]:
        return {"tunnel": self._state, "identifier": self._identifier, "error": self._error}

    def _set(self, state: str, error: Optional[str] = None) -> None:
        self._state = state
        self._error = error
        status = self.status()
        if status != self._last_status:
            self._last_status = status
            self._emit("status", status)

    # --- pair records ----------------------------------------------------------------------

    def _records(self) -> Iterator[Tuple[str, Path]]:
        for path in self._pmd3.pair_records.iter_remote_pair_records():
            yield _record_identifier(Path(path)), Path(path)

    def _has_record(self) -> bool:
        identifiers = [identifier for identifier, _ in self._records()]
        return self._identifier in identifiers if self._identifier else bool(identifiers)

    # --- tunnel ----------------------------------------------------------------------------

    def _connected(self) -> bool:
        return self._tunnel is not None and self._tunnel.rsd is not None

    async def _supervise(self) -> None:
        attempt = 0
        while not self._closed:
            if self._state == "unpaired":
                await self._sleep(None)
                continue
            if not self._connected():
                await self._drop_tunnel()
                self._set("connecting")
                try:
                    await asyncio.wait_for(self._open(), self._timings.connect_timeout_s)
                    attempt = 0
                    await self._keep_following()
                    self._set("connected")
                except asyncio.CancelledError:
                    raise
                except _NoRecordHere as exc:
                    self._set("unpaired", str(exc))
                    self._finish_attempt()
                    continue
                except Exception as exc:
                    _LOGGER.debug("Tunnel attempt failed", exc_info=True)
                    self._set("disconnected", _describe(exc))
                    delay = self._timings.retry_s[min(attempt, len(self._timings.retry_s) - 1)]
                    attempt += 1
                    self._finish_attempt()
                    await self._sleep(delay)
                    continue
                self._finish_attempt()
            else:
                await self._keep_following()
            await self._sleep(self._timings.health_s)

    async def _keep_following(self) -> None:
        """Follows the focus from the tunnel's start, so moves made before the first read count."""
        try:
            await asyncio.wait_for(self._accessibility(self._tunnel.rsd), self._timings.call_timeout_s)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Retried at every health check: only the first failure of a streak is news.
            log = _LOGGER.debug if self._follow_failing else _LOGGER.info
            log("Cannot follow the focus yet (%s); the next focus read retries", _describe(exc))
            self._follow_failing = True
            return
        if self._follow_failing:
            self._follow_failing = False
            _LOGGER.info("Following the focus again")

    def _finish_attempt(self) -> None:
        finished, self._attempt_finished = self._attempt_finished, asyncio.Event()
        assert finished is not None
        finished.set()

    async def _sleep(self, seconds: Optional[float]) -> None:
        assert self._wake is not None
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
        except asyncio.TimeoutError:
            pass
        self._wake.clear()

    async def _open(self) -> None:
        tunnel = self._pmd3.userspace_tunnel.UserspaceRsdTunnel(serial=self._identifier, autopair=False)
        try:
            await tunnel.aopen()
        except BaseException:
            await self._close_quietly(tunnel)
            raise
        self._tunnel = tunnel

    async def _drop_tunnel(self) -> None:
        await self._drop_accessibility()
        tunnel, self._tunnel = self._tunnel, None
        session_closed, self._session_closed = self._session_closed, False
        if session_closed:
            self._lost_session_pending = True
        if tunnel is not None:
            if session_closed and tunnel.rsd is not None:
                # A session's close must reach the daemon before the tunnel closes: the daemon ends a
                # lost session later, and ending any session untargets the one that follows the focus,
                # such as the next worker's.
                await asyncio.sleep(self._timings.session_close_s)
            await self._close_quietly(tunnel)

    @staticmethod
    async def _close_quietly(closeable: Any) -> None:
        try:
            close = getattr(closeable, "aclose", None) or closeable.close
            await close()
        except Exception:
            _LOGGER.debug("Closing %r failed", closeable, exc_info=True)

    async def _provider(self, serial: Optional[str], autopair: bool, remotepairing_fallback: bool = True):
        tunnel_service = self._pmd3.tunnel_service
        if self._endpoint is not None and self._identifier is not None:
            host, port = self._endpoint
            try:
                service = await tunnel_service.create_core_device_tunnel_service_using_remotepairing(
                    self._identifier, host, port
                )
                return service, None
            except Exception:
                _LOGGER.debug("The last RemotePairing endpoint %s:%s failed; browsing again", host, port, exc_info=True)
                self._endpoint = None
        services = await tunnel_service.get_remote_pairing_tunnel_services(udid=self._identifier)
        chosen = self._choose(services)
        for service in services:
            if service is not chosen:
                await self._close_quietly(service)
        if chosen is None:
            if services:
                raise _NoRecordHere(f"No pair record belongs to the Apple TV at {self._address}")
            raise ConnectionError("The Apple TV was not found over Bonjour with a matching pair record")
        self._identifier = chosen.remote_identifier
        self._endpoint = (chosen.hostname, chosen.port)
        return chosen, None

    def _choose(self, services: List[Any]) -> Any:
        if self._address is not None:
            for service in services:
                if _bare_ip(service.hostname) == self._address:
                    return service
            if self._identifier is None:
                # Without an identifier, a record of another Apple TV would be taken for this one's.
                return None
        candidates = [s for s in services if ":" not in s.hostname] or services
        if len({s.remote_identifier for s in candidates}) != 1:
            return None
        return candidates[0]

    async def _rsd(self) -> Any:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timings.connect_timeout_s
        while not self._connected():
            if self._state == "unpaired":
                raise self._not_paired()
            finished = self._attempt_finished
            assert finished is not None and self._wake is not None
            self._wake.set()
            remaining = deadline - loop.time()
            try:
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                await asyncio.wait_for(finished.wait(), remaining)
            except asyncio.TimeoutError:
                raise self._unavailable() from None
            if not self._connected() and self._state == "disconnected":
                raise self._unavailable()
        return self._tunnel.rsd

    def _not_paired(self) -> BridgeError:
        return BridgeError("SCREEN_NOT_PAIRED", "No RemotePairing pair record for this Apple TV")

    def _unavailable(self) -> BridgeError:
        reason = self._error or self._state
        return BridgeError("SCREEN_UNAVAILABLE", f"No tunnel to the Apple TV ({reason})", {"tunnel": self._state})

    async def _with_rsd(self, action: Callable[[Any], Any]) -> Any:
        for attempt in (1, 2):
            rsd = await self._rsd()
            try:
                return await asyncio.wait_for(action(rsd), self._timings.call_timeout_s)
            except BridgeError:
                raise
            except Exception as exc:
                if attempt == 2:
                    raise BridgeError("SCREEN_FAILED", f"The Apple TV did not answer: {_describe(exc)}", {"exception": type(exc).__name__}) from exc
                _LOGGER.info("Screen read failed (%s); retrying on a fresh tunnel", _describe(exc))
                await self._drop_tunnel()
                self._set("connecting")

    # --- requests --------------------------------------------------------------------------

    async def focus(self, params: Dict[str, Any]) -> Dict[str, Any]:
        assert self._focus_lock is not None
        # Aged from the request's arrival, as the plugin dates it from the send; the read takes ~0.2 s.
        received = asyncio.get_running_loop().time()
        async with self._focus_lock:
            focus, moved_at = await self._with_rsd(self._read_focus)
        return {"focus": focus, "ageMs": round((received - moved_at) * 1000)}

    async def _accessibility(self, rsd: Any) -> Any:
        """One accessibility session per tunnel, following the focus from the moment it opens."""
        assert self._ax_lock is not None
        async with self._ax_lock:
            return await self._open_accessibility(rsd)

    async def _open_accessibility(self, rsd: Any) -> Any:
        if self._ax is not None and self._ax_rsd is rsd and self._follower is not None and not self._follower.done():
            return self._ax
        await self._drop_accessibility()
        ax = self._pmd3.accessibilityaudit.AccessibilityAudit(rsd)
        await ax.__aenter__()
        self._ax, self._ax_rsd = ax, rsd
        try:
            await self._target(ax)
            await ax.set_show_visuals(False)
        except BaseException:
            await self._drop_accessibility()
            raise
        self._follower = asyncio.ensure_future(self._follow_focus(ax))
        self._retarget = asyncio.ensure_future(self._keep_targeted(ax))
        return ax

    async def _keep_targeted(self, ax: Any) -> None:
        """The Apple TV ends a session lost before this one at no set time, untargeting this one with
        no event to tell, and then highlights every focus move with nobody to clear it."""
        failing = False
        while True:
            await asyncio.sleep(self._timings.retarget_s)
            try:
                await asyncio.wait_for(self._target(ax), self._timings.call_timeout_s)
            except Exception as exc:
                if not failing:
                    _LOGGER.info("Targeting the accessibility session again failed (%s); retrying", _describe(exc))
                failing = True
                continue
            failing = False
            if self._lost_session_pending:
                self._lost_session_pending = False
                # The Apple TV may not have reported the moves made while the session was untargeted.
                self._unknown, self._focused = NOT_FOLLOWED, None

    @staticmethod
    async def _target(ax: Any) -> None:
        await ax._invoke("deviceDidGetTargeted")
        await ax.set_monitored_event_type(FOLLOW_FOCUS)

    async def _follow_focus(self, ax: Any) -> None:
        try:
            async for event in ax.iter_events(app_monitoring_enabled=False, monitored_event_type=FOLLOW_FOCUS):
                if event.name == MONITORED_TYPE_CHANGED and _first(event.data) != FOLLOW_FOCUS:
                    _LOGGER.info("Another accessibility inspector changed the monitored events; following the focus again shortly")
                    return
                if event.name == NOTIFICATION and _first(event.data) == SCREEN_CHANGE:
                    self._unknown, self._focused = SCREEN_CHANGED, None
                elif event.name == NOTIFICATION and _first(event.data) == LAYOUT_CHANGE and self._unknown is None:
                    self._unknown = LAYOUT_CHANGED
                elif event.name == PROPERTIES_CHANGED:
                    if self._unknown == LAYOUT_CHANGED and _same_element(getattr(_first(event.data), "element", None), self._focused):
                        # The move keeps its time.
                        self._unknown = None
                    # The daemon highlights the element it names again.
                    await ax.set_show_visuals(False)
                elif event.name == FOCUS_CHANGED:
                    self._focused = getattr(_first(event.data), "element", None)
                    self._moved_at = asyncio.get_running_loop().time()
                    self._unknown = None
                    # The daemon highlights each newly focused element, whatever it was told before.
                    await ax.set_show_visuals(False)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _LOGGER.info("Stopped following the focus (%s)", _describe(exc))
        finally:
            if self._ax is ax:
                self._unknown = NOT_FOLLOWED

    async def _drop_accessibility(self) -> None:
        ax, self._ax, self._ax_rsd = self._ax, None, None
        follower, self._follower = self._follower, None
        retarget, self._retarget = self._retarget, None
        self._unknown, self._focused = NOT_FOLLOWED, None
        if follower is not None:
            follower.cancel()
        if retarget is not None:
            retarget.cancel()
        if ax is not None:
            try:
                # The daemon keeps these after the session ends and would go on highlighting the focus.
                await asyncio.wait_for(self._stop_following(ax), INSPECTOR_RESET_S)
            except Exception:
                _LOGGER.debug("Resetting the accessibility inspector failed", exc_info=True)
            await self._close_quietly(ax)
            self._session_closed = True

    @staticmethod
    async def _stop_following(ax: Any) -> None:
        await ax.set_monitored_event_type(0)
        await ax.set_show_visuals(False)

    async def _read_focus(self, rsd: Any) -> Tuple[Dict[str, Optional[str]], float]:
        """The focused element and when tvOS reported it (loop time).

        The follower keeps taking events during the attribute read (about 0.2 s), so a read is used
        only when the focus is still the one it read: a move reads the new element, a screen change
        makes it unknown.
        """
        try:
            ax = await self._accessibility(rsd)
            while True:
                if self._unknown is not None:
                    raise _focus_unknown(self._unknown)
                element, moved_at = self._focused, self._moved_at
                if element is None:
                    raise _focus_unknown("The Apple TV reported a focus move without an element")
                attributes = await ax.element_attributes(element.identifier, FOCUS_ATTRIBUTES)
                if self._unknown is None and self._focused is element and self._moved_at == moved_at:
                    break
        except BridgeError:
            raise
        except BaseException:
            await self._drop_accessibility()
            raise
        focus = {
            "label": _text(attributes.get("Label")),
            "value": _text(attributes.get("Value")),
            "identifier": _text(attributes.get("Identifier")),
        }
        if all(v is None for v in focus.values()):
            raise _focus_unknown("The focused element has no label, value or identifier")
        return focus, moved_at

    async def screenshot(self, params: Dict[str, Any]) -> Dict[str, Any]:
        assert self._capture_lock is not None
        async with self._capture_lock:
            png = await self._with_rsd(self._capture)
        # About 1 s on a Pi for a 4K frame: off the loop, which follows the focus meanwhile.
        data = await asyncio.to_thread(image.encode, png, *image.options(params))
        image.write_private(params["path"], data)
        return {"bytes": len(data)}

    async def _capture(self, rsd: Any) -> bytes:
        async with self._pmd3.dvt_provider.DvtProvider(rsd) as dvt, self._pmd3.screenshot.Screenshot(dvt) as shot:
            return await shot.get_screenshot()

    async def foreground(self, params: Dict[str, Any]) -> Dict[str, Any]:
        assert self._foreground_lock is not None
        async with self._foreground_lock:
            processes = await self._with_rsd(self._processes)
        return _foreground(processes)

    async def _processes(self, rsd: Any) -> List[Dict[str, Any]]:
        async with self._pmd3.dvt_provider.DvtProvider(rsd) as dvt, self._pmd3.device_info.DeviceInfo(dvt) as info:
            return await info.proclist()

    # --- pairing ---------------------------------------------------------------------------

    def _read_pin(self, prompt: str = "") -> str:
        pairing = getattr(_THREAD, "pairing", None)
        if pairing is None:
            raise self._pmd3.exceptions.PairingError("No pairing is waiting for a PIN")
        return pairing.read_pin(prompt)

    async def pair_begin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self.pair_cancel({})
        identifier, host, port = await self._find_manual_pairing()
        pairing = _Pairing(self._pmd3, identifier, host, port, self._timings.pin_timeout_s)
        self._pairing = pairing
        pairing.start()
        try:
            await asyncio.wait_for(
                asyncio.wait({pairing.pin_requested, pairing.done}, return_when=asyncio.FIRST_COMPLETED),
                self._timings.connect_timeout_s,
            )
        except asyncio.TimeoutError:
            pass
        if pairing.done.done() and pairing.done.exception() is not None:
            self._pairing = None
            raise self._pairing_failed(pairing.done.exception())
        if not pairing.pin_requested.done() and not pairing.done.done():
            await self.pair_cancel({})
            raise BridgeError("PAIRING_FAILED", "The Apple TV did not ask for a PIN in time")
        return {}

    async def _find_manual_pairing(self) -> Tuple[str, str, int]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timings.browse_s
        while True:
            answers = await self._pmd3.bonjour.browse_remotepairing_manual_pairing()
            found = self._choose_manual(answers)
            if found is not None:
                return found
            if loop.time() >= deadline:
                raise BridgeError(
                    "PAIRING_FAILED",
                    f"The Apple TV does not offer RemotePairing right now: open {PAIRING_SCREEN} on it, then pair again",
                    {"reason": "not_advertised"},
                )
            await asyncio.sleep(min(1.0, max(0.0, deadline - loop.time())))

    def _choose_manual(self, answers: List[Any]) -> Optional[Tuple[str, str, int]]:
        def pick(answer: Any) -> Optional[Tuple[str, str, int]]:
            addresses = list(answer.addresses)
            if not addresses or not answer.properties.get("identifier"):
                return None
            match = next((a for a in addresses if a.ip == self._address), None)
            ipv4 = next((a for a in addresses if ":" not in a.ip), None)
            address = match or ipv4 or addresses[0]
            return answer.properties["identifier"], address.full_ip, answer.port

        if self._address is not None:
            for answer in answers:
                if any(a.ip == self._address for a in answer.addresses):
                    return pick(answer)
        return pick(answers[0]) if len(answers) == 1 else None

    def _pairing_failed(self, exc: BaseException) -> BridgeError:
        return BridgeError("PAIRING_FAILED", f"RemotePairing failed: {_describe(exc)}", {"exception": type(exc).__name__})

    async def pair_pin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        pairing = self._pairing
        if pairing is None:
            raise BridgeError("PAIRING_NOT_FOUND", "No RemotePairing is waiting for a PIN; start with pair.begin")
        pairing.send_pin(params["pin"])
        try:
            await asyncio.wait_for(asyncio.shield(pairing.done), self._timings.call_timeout_s)
        except asyncio.TimeoutError:
            # The Apple TV may still confirm: use the record as soon as it does.
            pairing.done.add_done_callback(
                lambda done: done.cancelled() or done.exception() or asyncio.ensure_future(self._paired(pairing.identifier))
            )
            raise BridgeError("DEVICE_TIMEOUT", "The Apple TV did not confirm the pairing in time") from None
        except Exception as exc:
            raise self._pairing_failed(exc) from exc
        finally:
            if self._pairing is pairing:
                self._pairing = None
        await self._paired(pairing.identifier)
        return {"identifier": pairing.identifier}

    async def _paired(self, identifier: str) -> None:
        self._identifier = identifier
        self._endpoint = None
        await self._drop_tunnel()
        self._set("connecting")
        assert self._wake is not None
        self._wake.set()

    async def pair_cancel(self, params: Dict[str, Any]) -> Dict[str, Any]:
        pairing, self._pairing = self._pairing, None
        if pairing is not None:
            pairing.send_pin(None)
            try:
                await asyncio.wait_for(asyncio.shield(pairing.done), 2.0)
            except Exception:
                pass
        return {}
