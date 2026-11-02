"""A scriptable stand-in for the parts of pymobiledevice3 11.49.1 the screen worker uses (seam W1).

The worker reaches pymobiledevice3 only through a namespace of modules (agent_atv_screen.pmd3.load());
FakePmd3.modules() builds that namespace from this module. Names listed in IMITATES exist in the real
modules with compatible signatures; test_pmd3_surface.py (seam W2) checks them. Test controls are
FakePmd3 attributes or `fake_` instance attributes, never imitated members.
"""

from __future__ import annotations

import asyncio
import dataclasses
import errno
import socket
import threading
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent_atv_screen.backend_fake import fake_png

IMITATES = {
    "pymobiledevice3.remote.userspace_tunnel": [
        "UserspaceRsdTunnel",
        "_create_no_root_tunnel_provider",
        "UserspaceTun",
        "LOOPBACK_HEADER",
        "_ETH_HDR_TO_STACK",
    ],
    "pymobiledevice3.remote.tunnel_service": [
        "create_core_device_tunnel_service_using_remotepairing",
        "get_remote_pairing_tunnel_services",
        "RemotePairingManualPairingService",
    ],
    "pymobiledevice3.bonjour": ["browse_remotepairing_manual_pairing", "ServiceInstance", "Address"],
    "pymobiledevice3.services.accessibilityaudit": ["AccessibilityAudit", "deserialize_object"],
    "pymobiledevice3.services.dvt.instruments.dvt_provider": ["DvtProvider"],
    "pymobiledevice3.services.dvt.instruments.screenshot": ["Screenshot"],
    "pymobiledevice3.services.dvt.instruments.device_info": ["DeviceInfo"],
    "pymobiledevice3.dtx._reader": ["MAX_BUFFERED_SIZE"],
    "pymobiledevice3.exceptions": ["RemotePairingCompletedError", "PairingError", "PyMobileDevice3Exception"],
    "pymobiledevice3.pair_records": ["iter_remote_pair_records"],
}

MAX_BUFFERED_SIZE = 30 * 1024 * 1024
_FAKE: Optional["FakePmd3"] = None


class PyMobileDevice3Exception(Exception):
    pass


class PairingError(PyMobileDevice3Exception):
    pass


class RemotePairingCompletedError(PyMobileDevice3Exception):
    pass


class Address:
    def __init__(self, ip: str, iface: str) -> None:
        self.ip = ip
        self.iface = iface

    @property
    def full_ip(self) -> str:
        return f"{self.ip}%{self.iface}" if self.iface and self.ip.lower().startswith("fe80:") else self.ip


class ServiceInstance:
    def __init__(self, instance: str, host: Optional[str], port: int, addresses=None, properties=None) -> None:
        self.instance = instance
        self.host = host
        self.port = port
        self.addresses = addresses or []
        self.properties = properties or {}


class _TunnelService:
    """What create_core_device_tunnel_service_using_remotepairing returns."""

    def __init__(self, remote_identifier: str, hostname: str, port: int) -> None:
        self._remote_identifier = remote_identifier
        self.hostname = hostname
        self.port = port
        self.fake_closed = False

    @property
    def remote_identifier(self) -> str:
        return self._remote_identifier

    async def close(self) -> None:
        self.fake_closed = True


def _fake() -> "FakePmd3":
    assert _FAKE is not None, "build a FakePmd3 first"
    return _FAKE


async def create_core_device_tunnel_service_using_remotepairing(
    remote_identifier: str, hostname: str, port: int, autopair: bool = True
) -> _TunnelService:
    fake = _fake()
    fake.direct_connects.append((remote_identifier, hostname, port))
    if not fake.reachable or (hostname, port) not in fake.endpoints():
        raise ConnectionRefusedError(f"cannot reach {hostname}:{port}")
    return _TunnelService(remote_identifier, hostname, port)


async def get_remote_pairing_tunnel_services(
    bonjour_timeout: float = 3, udid: Optional[str] = None, excluded_identifiers=()
) -> List[_TunnelService]:
    fake = _fake()
    fake.discoveries.append(udid)
    if not fake.reachable:
        return []
    services = []
    for identifier in fake.records:
        if udid is not None and identifier != udid:
            continue
        for address in fake.record_addresses.get(identifier, fake.addresses):
            service = _TunnelService(identifier, address, fake.tunnel_port)
            fake.discovered.append(service)
            services.append(service)
    return services


async def _create_no_root_tunnel_provider(serial: Optional[str], autopair: bool, remotepairing_fallback: bool = True):
    raise PyMobileDevice3Exception("Failed to connect to usbmuxd socket")


# The values on macOS; LOOPBACK_HEADER is per OS.
LOOPBACK_HEADER = b"\x00\x00\x00\x1e"
_ETH_HDR_TO_STACK = b"\x02\x00\x00\x00\x00\x01\x02\x00\x00\x00\x00\x02\x86\xdd"
# What an unprivileged process gets: Linux caps the 6 MiB pymobiledevice3 asks for at net.core.wmem_max.
FAKE_TUN_BUFFER_BYTES = 16 * 1024


class UserspaceTun:
    """The userspace tunnel's interface: write() hands each inbound packet to the PyTCP stack
    through a non-blocking datagram socketpair and, like the real one, drops it when the buffer is
    full. The test reads the stack's end, `_pend`."""

    def __init__(self, interface_name: str = "utun-userspace") -> None:
        self._closed = False
        self._send_error_logged = False
        self._peer, self._pend = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        for s in (self._peer, self._pend):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, FAKE_TUN_BUFFER_BYTES)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, FAKE_TUN_BUFFER_BYTES)
        self._peer.setblocking(False)
        self._pend.setblocking(False)

    def write(self, data: bytes) -> None:
        ipv6 = data[len(LOOPBACK_HEADER) :] if data[: len(LOOPBACK_HEADER)] == LOOPBACK_HEADER else data
        try:
            self._peer.send(_ETH_HDR_TO_STACK + ipv6)
        except BlockingIOError:
            pass
        except OSError as e:
            if e.errno != errno.ENOBUFS:
                raise

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for s in (self._peer, self._pend):
            s.close()


class _Rsd:
    def __init__(self, provider: _TunnelService) -> None:
        self.fake_provider = provider
        self.product_version = "27.2"


class UserspaceRsdTunnel:
    def __init__(self, serial: Optional[str] = None, autopair: bool = True, remotepairing_fallback: bool = True) -> None:
        self.serial = serial
        self.autopair = autopair
        self.rsd: Optional[_Rsd] = None
        self._provider: Optional[_TunnelService] = None

    async def aopen(self) -> _Rsd:
        fake = _fake()
        if fake.open_tunnels:
            raise PyMobileDevice3Exception("A userspace tunnel is already active in this process")
        # Looked up as a module global, like the real class, so the worker's replacement applies.
        provider, _lockdown = await _create_no_root_tunnel_provider(self.serial, self.autopair, True)
        if fake.tunnel_delay_s:
            await asyncio.sleep(fake.tunnel_delay_s)
        self._provider = provider
        self.rsd = _Rsd(provider)
        fake.open_tunnels.append(self)
        fake.tunnel_opens += 1
        return self.rsd

    async def aclose(self) -> None:
        fake = _fake()
        if self in fake.open_tunnels:
            fake.open_tunnels.remove(self)
            fake.lose_sessions(self.rsd)
        if self._provider is not None:
            await self._provider.close()
        self.rsd = None

    def fake_drop(self) -> None:
        """What the real transport watcher does when the Apple TV goes away."""
        fake = _fake()
        fake.open_tunnels.remove(self)
        fake.lose_sessions(self.rsd)
        self.rsd = None


class AXAuditElement_v1:
    def __init__(self, fields: Dict[str, Any]) -> None:
        self._fields = fields

    @property
    def identifier(self) -> bytes:
        return self._fields["PlatformElementValue_v1"]


class AXAuditInspectorFocus_v1:
    def __init__(self, fields: Dict[str, Any]) -> None:
        self._fields = fields

    @property
    def caption(self) -> Optional[str]:
        return self._fields.get("CaptionTextValue_v1")

    @property
    def element(self) -> Optional[AXAuditElement_v1]:
        return self._fields.get("ElementValue_v1")


@dataclasses.dataclass
class Event:
    name: str
    data: Any


def deserialize_object(d: Any) -> Any:
    if isinstance(d, dict) and d.get("ObjectType") == "AXAuditElement_v1":
        return AXAuditElement_v1({"PlatformElementValue_v1": d["Value"]})
    return d


def _require_open(rsd: _Rsd, inject: bool = True) -> None:
    fake = _fake()
    if not any(t.rsd is rsd for t in fake.open_tunnels):
        raise ConnectionResetError("the tunnel is closed")
    if inject and fake.ax_broken is not None:
        raise fake.ax_broken
    if inject and fake.fail_next:
        error = fake.fail_next.pop(0)
        raise error


class AccessibilityAudit:
    """The axAuditDaemon as measured on tvOS 27: inspector state (monitored event type, highlight,
    target) belongs to the daemon and outlives sessions; the session that last called
    deviceDidGetTargeted gets a hostInspectorCurrentElementChanged: event for each focus move while
    the monitored type is 2, and the daemon then highlights the element whatever
    deviceInspectorShowVisuals said before. The same session also gets
    hostInspectorNotificationReceived: for the notifications apps post. The end of any session, once
    the daemon learns of it, leaves no session targeted. Once the Apple TV disposes of lost sessions,
    a session targeted again gets notifications but no focus moves until the monitored type is set
    again."""

    def __init__(self, lockdown: Any) -> None:
        self._rsd = lockdown
        self.fake_events: "asyncio.Queue[Event]" = asyncio.Queue()

    async def __aenter__(self) -> "AccessibilityAudit":
        _require_open(self._rsd)
        fake = _fake()
        fake.ax_sessions += 1
        fake.open_sessions.append(self)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        fake = _fake()
        if self in fake.open_sessions:
            fake.open_sessions.remove(self)
            if fake.close_flush_s:
                fake.closing_sessions[self] = asyncio.get_running_loop().call_later(fake.close_flush_s, fake.session_ended, self)
            else:
                fake.session_ended(self)

    async def _invoke(self, selector: str, *args: Any, expects_reply: bool = True) -> Any:
        _require_open(self._rsd, inject=False)
        fake = _fake()
        fake.ax_calls.append((selector, args))
        if selector == "deviceDidGetTargeted":
            fake.target = self
        if selector == "deviceFetchSpecialElement:" and fake.screen:
            # 0 and 1 are the first and the last element of the screen, not the focus.
            element = {0: fake.screen[0], 1: fake.screen[-1]}.get(args[0])
            return None if element is None else {"ObjectType": "AXAuditElement_v1", "Value": element}
        return None

    async def set_show_visuals(self, value: bool) -> None:
        _require_open(self._rsd, inject=False)
        fake = _fake()
        fake.ax_calls.append(("deviceInspectorShowVisuals:", (int(value),)))
        if not value:
            fake.highlighted = None

    async def set_monitored_event_type(self, event_type: Optional[int] = None) -> None:
        _require_open(self._rsd, inject=False)
        fake = _fake()
        fake.ax_calls.append(("deviceInspectorSetMonitoredEventType:", (event_type or 0,)))
        fake.set_monitored_type(event_type or 0)

    async def iter_events(self, app_monitoring_enabled: bool = True, monitored_event_type: Optional[int] = None):
        await self._invoke("deviceSetAppMonitoringEnabled:", app_monitoring_enabled)
        await self.set_monitored_event_type(monitored_event_type)
        while True:
            yield await self.fake_events.get()

    async def element_attributes(self, element: bytes, attributes: List[str]) -> Dict[str, Any]:
        _require_open(self._rsd)
        fake = _fake()
        fake.ax_calls.append(("element_attributes", (element, tuple(attributes))))
        if fake.attributes_delay_s:
            await asyncio.sleep(fake.attributes_delay_s)
        known = fake.elements.get(element, {})
        return {name: known.get(name) for name in attributes}


class DvtProvider:
    def __init__(self, lockdown: Any) -> None:
        self._rsd = lockdown

    async def __aenter__(self) -> "DvtProvider":
        _require_open(self._rsd)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        pass


class Screenshot:
    def __init__(self, provider: DvtProvider) -> None:
        self._provider = provider

    async def __aenter__(self) -> "Screenshot":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        pass

    async def get_screenshot(self) -> bytes:
        fake = _fake()
        if fake.capture_delay_s:
            await asyncio.sleep(fake.capture_delay_s)
        return fake.png


class DeviceInfo:
    """DVT deviceinfo: proclist() is runningProcesses, as tvOS 27.2 sends it."""

    def __init__(self, provider: DvtProvider) -> None:
        self._provider = provider

    async def __aenter__(self) -> "DeviceInfo":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        pass

    async def proclist(self) -> List[Dict[str, Any]]:
        fake = _fake()
        fake.proclist_reads += 1
        return [dict(process) for process in fake.processes]


def _application(bundle_id: str, display_name: str, executable: str, pid: int) -> Dict[str, Any]:
    return {
        "isApplication": True,
        "displayLocalizedAppName": display_name,
        "bundleIdentifier": bundle_id,
        "foregroundRunning": False,
        "name": executable,
        "pid": pid,
        "realAppName": f"/Applications/{executable}.app",
        "startDate": None,
    }


# Running processes as tvOS 27.2 lists them (abridged). Applications carry the app fields; the
# process `name` is the executable, not the app's name (Disney+ runs as DominguezTV).
def _processes() -> List[Dict[str, Any]]:
    return [
        {"name": "launchd", "pid": 1, "startDate": None},
        _application("com.apple.PineBoard", "PineBoard", "PineBoard", 39),
        _application("com.apple.TVSystemUIService", "TVSystemUIService", "TVSystemUIService", 161),
        _application("com.apple.HeadBoard", "HeadBoard", "HeadBoard", 164),
        _application("com.apple.AccessibilityUIServer", "Accessibility", "AccessibilityUIServer", 201),
        _application("com.apple.IdleScreen", "IdleScreen", "IdleScreen", 349),
        _application("com.apple.TVSettings", "Settings", "TVSettings", 314),
        _application("com.netflix.Netflix", "Netflix", "Argo", 512),
        _application("com.disney.disneyplus", "Disney+", "DominguezTV", 489),
        {"name": "AerialPoster", "pid": 350, "startDate": None, "foregroundRunning": False},
    ]


async def browse_remotepairing_manual_pairing(timeout: float = 3) -> List[ServiceInstance]:
    fake = _fake()
    fake.manual_browses += 1
    if not fake.advertises_manual_pairing:
        return []
    return [
        ServiceInstance(
            "Living Room._remotepairing-manual-pairing._tcp.local.",
            "Living-Room.local",
            fake.manual_port,
            [Address(ip, "eth0") for ip in fake.addresses],
            {"identifier": fake.pairing_identifier, "name": "Living Room"},
        )
    ]


class RemotePairingManualPairingService:
    def __init__(self, remote_identifier: str, hostname: str, port: int) -> None:
        self._remote_identifier = remote_identifier
        self.hostname = hostname
        self.port = port

    @property
    def remote_identifier(self) -> str:
        return self._remote_identifier

    async def connect(self, autopair: bool = True) -> None:
        fake = _fake()
        fake.manual_connects.append((self._remote_identifier, self.hostname, self.port, threading.current_thread()))
        if fake.pairing_rejection:
            raise PairingError(fake.pairing_rejection)
        # The real _request_pair_consent reads the Apple TV PIN with a bare input() call.
        pin = input("Enter PIN: ")
        if pin != fake.pairing_pin:
            raise PairingError("Pairing failed: Authentication")
        if fake.pairing_confirm_delay_s:
            await asyncio.sleep(fake.pairing_confirm_delay_s)
        fake.records.append(self._remote_identifier)
        raise RemotePairingCompletedError()

    async def close(self) -> None:
        pass


def iter_remote_pair_records():
    return iter(Path(f"remote_{identifier}.plist") for identifier in list(_fake().records))


class FakePmd3:
    """Test controls plus the namespace the worker gets (`modules()`)."""

    def __init__(self) -> None:
        global _FAKE
        _FAKE = self
        self.records: List[str] = []
        self.addresses = ["fe80::1", "192.168.1.50", "2001:db8::50"]
        # Addresses of the Apple TVs behind other pair records.
        self.record_addresses: Dict[str, List[str]] = {}
        self.tunnel_port = 49155
        self.reachable = True
        self.tunnel_delay_s = 0.0
        self.capture_delay_s = 0.0
        # How long an element_attributes read takes (about 0.2 s on a Pi).
        self.attributes_delay_s = 0.0
        self.fail_next: List[BaseException] = []
        # Every accessibility call fails with it while set.
        self.ax_broken: Optional[BaseException] = None
        # The Apple TV's accessibility elements by platform element value, in screen order.
        self.elements: Dict[bytes, Dict[str, Any]] = {
            b"\x01first": {"Label": "TV", "Value": "", "Identifier": "AppCell"},
            b"\x02arrow": {"Label": "Swipe up for full screen", "Value": None, "Identifier": "top-shelf/swipe-up-affordance/arrow"},
            b"\x03last": {"Label": "M6+", "Value": "Recently Updated", "Identifier": "AppCell"},
        }
        # Daemon state, shared by every session and kept after they close.
        self.monitored_type = 0
        self.target: Optional[AccessibilityAudit] = None
        # Whether the target gets focus moves: after a disposal of lost sessions, only once the
        # monitored type is set again while a session is targeted (measured on tvOS 27).
        self.reports_focus = True
        self.highlighted: Optional[bytes] = None
        # How long a session's close takes to reach the daemon through the tunnel; a tunnel closed
        # sooner loses it, and the daemon learns of that session's end only later
        # (dispose_lost_sessions).
        self.close_flush_s = 0.0
        self.closing_sessions: Dict[AccessibilityAudit, asyncio.TimerHandle] = {}
        self.lost_sessions: List[AccessibilityAudit] = []
        self.focused: Optional[bytes] = None
        self.png = fake_png(3840, 2160)
        self.processes: List[Dict[str, Any]] = _processes()
        self.show("com.apple.HeadBoard")
        self.proclist_reads = 0
        self.advertises_manual_pairing = True
        self.manual_port = 49160
        self.pairing_identifier = "0A1B2C3D-0000-4000-8000-00000000AA01"
        self.pairing_pin = "123456"
        self.pairing_rejection: Optional[str] = None
        # How long the Apple TV takes to confirm a correct PIN.
        self.pairing_confirm_delay_s = 0.0
        # Recorded calls
        self.open_tunnels: List[UserspaceRsdTunnel] = []
        self.tunnel_opens = 0
        self.direct_connects: List[tuple] = []
        self.discoveries: List[Optional[str]] = []
        self.discovered: List[_TunnelService] = []
        self.ax_calls: List[tuple] = []
        self.ax_sessions = 0
        self.open_sessions: List[AccessibilityAudit] = []
        self.manual_browses = 0
        self.manual_connects: List[tuple] = []

    @property
    def screen(self) -> List[bytes]:
        return list(self.elements)

    def move_focus(self, element: Optional[bytes]) -> None:
        """tvOS moves its focus (a key press); None: nothing focused any more."""
        followers = self._followers() if self.reports_focus else []
        if not followers:
            return
        self.focused = element
        self.highlighted = element
        for session in followers:
            session.fake_events.put_nowait(Event("hostInspectorCurrentElementChanged:", [self._inspector_focus(element)]))

    def relayout(self) -> None:
        """The home screen's layout changes, about 0.2 s after each focus move and every 30 s or so at
        rest: LayoutChanged, then hostInspectorCurrentElementPropertiesChanged: for the element still
        focused, which the daemon highlights again."""
        self.post_notification("UIAccessibilityLayoutChangedNotification")
        followers = self._followers()
        if not followers or self.focused is None:
            return
        self.highlighted = self.focused
        for session in followers:
            session.fake_events.put_nowait(Event("hostInspectorCurrentElementPropertiesChanged:", [self._inspector_focus(self.focused)]))

    def _followers(self) -> List["AccessibilityAudit"]:
        target = self.target
        return [target] if self.monitored_type == 2 and target in self.open_sessions else []

    def session_ended(self, session: "AccessibilityAudit") -> None:
        self.closing_sessions.pop(session, None)
        self.target = None

    def lose_sessions(self, rsd: Any) -> None:
        """A tunnel closes: the sessions it still carried, or whose close it had not delivered yet."""
        for session in [s for s in self.open_sessions if s._rsd is rsd]:
            self.open_sessions.remove(session)
            self.lost_sessions.append(session)
        for session in [s for s in self.closing_sessions if s._rsd is rsd]:
            self.closing_sessions.pop(session).cancel()
            self.lost_sessions.append(session)

    def dispose_lost_sessions(self) -> None:
        """What the Apple TV does 20 to 35 s after a tunnel closed under a session."""
        if self.lost_sessions:
            self.lost_sessions.clear()
            self.target = None
            self.reports_focus = False

    def _inspector_focus(self, element: Optional[bytes]) -> AXAuditInspectorFocus_v1:
        label = self.elements.get(element, {}).get("Label") if element is not None else None
        return AXAuditInspectorFocus_v1({
            "CaptionTextValue_v1": label,
            "ElementValue_v1": None if element is None else AXAuditElement_v1({"PlatformElementValue_v1": element}),
        })

    def post_notification(self, name: str) -> None:
        """An app posts a UIAccessibility notification; a following session receives it. A screen
        that changes without moving the focus sends no focus event."""
        for session in self._followers():
            session.fake_events.put_nowait(Event("hostInspectorNotificationReceived:", name))

    def set_monitored_type(self, event_type: int) -> None:
        """Also what another inspector client (Accessibility Inspector) does."""
        self.monitored_type = event_type
        if self.target is not None:
            self.reports_focus = True
        for session in self.open_sessions:
            session.fake_events.put_nowait(Event("hostInspectorMonitoredEventTypeChanged:", event_type))

    def show(self, *names: str) -> None:
        """What tvOS shows: these processes (bundle ids, or names) run in the foreground, with
        PineBoard and TVSystemUIService, which always do."""
        shown = {"com.apple.PineBoard", "com.apple.TVSystemUIService", *names}
        for process in self.processes:
            if "foregroundRunning" in process:
                process["foregroundRunning"] = process.get("bundleIdentifier", process["name"]) in shown

    def endpoints(self):
        addresses = set(self.addresses).union(*self.record_addresses.values())
        return {(address, self.tunnel_port) for address in addresses}

    def modules(self) -> types.SimpleNamespace:
        module = __import__(__name__, fromlist=["_"])
        return types.SimpleNamespace(
            version="11.49.1",
            userspace_tunnel=module,
            tunnel_service=module,
            bonjour=module,
            accessibilityaudit=module,
            dvt_provider=module,
            screenshot=module,
            device_info=module,
            dtx_reader=module,
            exceptions=module,
            pair_records=module,
        )
