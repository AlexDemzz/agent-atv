"""A scriptable stand-in for the pyatv 0.18 module, faked at its public boundary (seam B2).

Every class, member and keyword argument here imitates pyatv; test_pyatv_surface.py (seam B3)
checks them against the installed pyatv. Test controls live in instance attributes prefixed
with `fake_` or in FakePyatv itself, never in the imitated class bodies.
"""

from __future__ import annotations

import asyncio
import types
import weakref
from enum import Enum
from typing import Any, Dict, List, Optional


class Protocol(Enum):
    DMAP = 1
    MRP = 2
    AirPlay = 3
    Companion = 4
    RAOP = 5


class MediaType(Enum):
    Unknown = 0
    Video = 1
    Music = 2
    TV = 3


class DeviceState(Enum):
    Idle = 0
    Loading = 1
    Paused = 2
    Playing = 3
    Stopped = 4
    Seeking = 5


class PowerState(Enum):
    Unknown = 0
    Off = 1
    On = 2


class SystemStatus(Enum):
    """pyatv.protocols.companion.api.SystemStatus, not in pyatv.const."""

    Unknown = 0
    Asleep = 1
    Screensaver = 2
    Awake = 3
    Idle = 4


class KeyboardFocusState(Enum):
    Unknown = 0
    Unfocused = 1
    Focused = 2


class OperatingSystem(Enum):
    Unknown = 0
    Legacy = 1
    TvOS = 2
    AirPortOS = 3
    MacOS = 4


class InputAction(Enum):
    SingleTap = 0
    DoubleTap = 1
    Hold = 2


class PairingRequirement(Enum):
    Unsupported = 1
    Disabled = 2
    NotNeeded = 3
    Optional = 4
    Mandatory = 5


class FeatureState(Enum):
    Unknown = 0
    Unsupported = 1
    Unavailable = 2
    Available = 3


class FeatureName(Enum):
    Volume = 45


const = types.SimpleNamespace(
    FeatureState=FeatureState,
    FeatureName=FeatureName,
    Protocol=Protocol,
    MediaType=MediaType,
    DeviceState=DeviceState,
    PowerState=PowerState,
    KeyboardFocusState=KeyboardFocusState,
    OperatingSystem=OperatingSystem,
    InputAction=InputAction,
    PairingRequirement=PairingRequirement,
    __version__="0.18.0",
)


class ConnectionFailedError(Exception):
    pass


class ConnectionLostError(Exception):
    pass


class PairingError(Exception):
    pass


class AuthenticationError(Exception):
    pass


class NotSupportedError(NotImplementedError):
    pass


class NoCredentialsError(Exception):
    pass


class InvalidCredentialsError(Exception):
    pass


class CommandError(Exception):
    pass


class BlockedStateError(Exception):
    pass


class InvalidResponseError(Exception):
    pass


class OperationTimeoutError(Exception):
    pass


class ProtocolError(Exception):
    pass


exceptions = types.SimpleNamespace(
    ConnectionFailedError=ConnectionFailedError,
    ConnectionLostError=ConnectionLostError,
    PairingError=PairingError,
    AuthenticationError=AuthenticationError,
    NotSupportedError=NotSupportedError,
    NoCredentialsError=NoCredentialsError,
    InvalidCredentialsError=InvalidCredentialsError,
    CommandError=CommandError,
    BlockedStateError=BlockedStateError,
    InvalidResponseError=InvalidResponseError,
    OperationTimeoutError=OperationTimeoutError,
    ProtocolError=ProtocolError,
)


class _StateProducer:
    """pyatv keeps listeners as weak references; so does the fake."""

    def __init__(self) -> None:
        self._listener_ref: Optional[weakref.ReferenceType] = None

    @property
    def listener(self) -> Any:
        return self._listener_ref() if self._listener_ref is not None else None

    @listener.setter
    def listener(self, target: Any) -> None:
        self._listener_ref = weakref.ref(target) if target is not None else None


class FakeService:
    IMITATES = "interface.BaseService"
    credentials: Optional[str] = None
    enabled = True

    def __init__(self, protocol: Protocol, port: int, identifier: Optional[str] = None,
                 pairing: PairingRequirement = PairingRequirement.Mandatory) -> None:
        self._protocol = protocol
        self._port = port
        self._identifier = identifier
        self._pairing = pairing

    @property
    def protocol(self) -> Protocol:
        return self._protocol

    @property
    def port(self) -> int:
        return self._port

    @property
    def identifier(self) -> Optional[str]:
        return self._identifier

    @property
    def pairing(self) -> PairingRequirement:
        return self._pairing


class FakeDeviceInfo:
    IMITATES = "interface.DeviceInfo"

    def __init__(self, operating_system: OperatingSystem = OperatingSystem.TvOS, version: Optional[str] = "27.2",
                 model_str: str = "Apple TV 4K (gen 3)", mac: Optional[str] = "A1:B2:C3:D4:E5:F6") -> None:
        self._operating_system = operating_system
        self._version = version
        self._model_str = model_str
        self._mac = mac

    @property
    def operating_system(self) -> OperatingSystem:
        return self._operating_system

    @property
    def version(self) -> Optional[str]:
        return self._version

    @property
    def model_str(self) -> str:
        return self._model_str

    @property
    def mac(self) -> Optional[str]:
        return self._mac


class FakeConfig:
    IMITATES = "interface.BaseConfig"

    def __init__(self, name: str = "Living Room", address: str = "192.168.1.50",
                 device_info: Optional[FakeDeviceInfo] = None, services: Optional[List[FakeService]] = None,
                 identifiers: Optional[List[str]] = None) -> None:
        self._name = name
        self._address = address
        self._device_info = device_info or FakeDeviceInfo()
        self._services = services if services is not None else [
            FakeService(Protocol.Companion, 49153, "0E5C1C1E-3A4B-4C7D-9E2F-6A1B2C3D4E5F"),
            FakeService(Protocol.AirPlay, 7000, "A1:B2:C3:D4:E5:F6"),
        ]
        self._identifiers = identifiers if identifiers is not None else [
            "0E5C1C1E-3A4B-4C7D-9E2F-6A1B2C3D4E5F", "A1:B2:C3:D4:E5:F6", "A1B2C3D4E5F6",
        ]

    @property
    def name(self) -> str:
        return self._name

    @property
    def address(self) -> str:
        return self._address

    @property
    def device_info(self) -> FakeDeviceInfo:
        return self._device_info

    @property
    def services(self) -> List[FakeService]:
        return list(self._services)

    @property
    def identifier(self) -> Optional[str]:
        return self._identifiers[0] if self._identifiers else None

    @property
    def all_identifiers(self) -> List[str]:
        return list(self._identifiers)

    def get_service(self, protocol: Protocol) -> Optional[FakeService]:
        for service in self._services:
            if service.protocol == protocol:
                return service
        return None

    def set_credentials(self, protocol: Protocol, credentials: str) -> bool:
        service = self.get_service(protocol)
        if service is None:
            return False
        service.credentials = credentials
        return True


class FakePlaying:
    IMITATES = "interface.Playing"

    def __init__(self, device_state: DeviceState = DeviceState.Idle, media_type: MediaType = MediaType.Unknown,
                 title: Optional[str] = None, artist: Optional[str] = None, album: Optional[str] = None,
                 series_name: Optional[str] = None, season_number: Optional[int] = None,
                 episode_number: Optional[int] = None, position: Optional[int] = None,
                 total_time: Optional[int] = None) -> None:
        self._values = dict(device_state=device_state, media_type=media_type, title=title, artist=artist,
                            album=album, series_name=series_name, season_number=season_number,
                            episode_number=episode_number, position=position, total_time=total_time)

    device_state = property(lambda self: self._values["device_state"])
    media_type = property(lambda self: self._values["media_type"])
    title = property(lambda self: self._values["title"])
    artist = property(lambda self: self._values["artist"])
    album = property(lambda self: self._values["album"])
    series_name = property(lambda self: self._values["series_name"])
    season_number = property(lambda self: self._values["season_number"])
    episode_number = property(lambda self: self._values["episode_number"])
    position = property(lambda self: self._values["position"])
    total_time = property(lambda self: self._values["total_time"])


class FakeApp:
    IMITATES = "interface.App"

    def __init__(self, name: Optional[str], identifier: str) -> None:
        self._name = name
        self._identifier = identifier

    @property
    def name(self) -> Optional[str]:
        return self._name

    @property
    def identifier(self) -> str:
        return self._identifier


class FakeFeatureInfo:
    IMITATES = "interface.FeatureInfo"

    def __init__(self, state: FeatureState) -> None:
        self._state = state

    @property
    def state(self) -> FeatureState:
        return self._state


class FakeFeatures:
    IMITATES = "interface.Features"

    def __init__(self) -> None:
        self.fake_states: Dict[FeatureName, FeatureState] = {}

    def get_feature(self, feature_name: FeatureName) -> FakeFeatureInfo:
        return FakeFeatureInfo(self.fake_states.get(feature_name, FeatureState.Available))


class _Recorder:
    """Records calls into `fake_calls`, optionally failing or blocking them."""

    def __init__(self) -> None:
        self.fake_calls: List[tuple] = []
        self.fake_errors: Dict[str, BaseException] = {}
        self.fake_gates: Dict[str, asyncio.Event] = {}

    async def _record(self, name: str, *args: Any, **kwargs: Any) -> None:
        self.fake_calls.append((name, args, kwargs))
        gate = self.fake_gates.get(name)
        if gate is not None:
            await gate.wait()
        error = self.fake_errors.get(name)
        if error is not None:
            raise error


class FakeRemoteControl(_Recorder):
    IMITATES = "interface.RemoteControl"

    async def up(self, action: InputAction = InputAction.SingleTap) -> None:
        await self._record("up", action=action)

    async def down(self, action: InputAction = InputAction.SingleTap) -> None:
        await self._record("down", action=action)

    async def left(self, action: InputAction = InputAction.SingleTap) -> None:
        await self._record("left", action=action)

    async def right(self, action: InputAction = InputAction.SingleTap) -> None:
        await self._record("right", action=action)

    async def select(self, action: InputAction = InputAction.SingleTap) -> None:
        await self._record("select", action=action)

    async def menu(self, action: InputAction = InputAction.SingleTap) -> None:
        await self._record("menu", action=action)

    async def home(self, action: InputAction = InputAction.SingleTap) -> None:
        await self._record("home", action=action)

    async def home_hold(self) -> None:
        await self._record("home_hold")

    async def top_menu(self) -> None:
        await self._record("top_menu")

    async def play(self) -> None:
        await self._record("play")

    async def pause(self) -> None:
        await self._record("pause")

    async def play_pause(self) -> None:
        await self._record("play_pause")

    async def stop(self) -> None:
        await self._record("stop")

    async def next(self) -> None:
        await self._record("next")

    async def previous(self) -> None:
        await self._record("previous")

    async def volume_up(self) -> None:
        await self._record("volume_up")

    async def volume_down(self) -> None:
        await self._record("volume_down")

    async def channel_up(self) -> None:
        await self._record("channel_up")

    async def channel_down(self) -> None:
        await self._record("channel_down")

    async def screensaver(self) -> None:
        await self._record("screensaver")

    async def guide(self) -> None:
        await self._record("guide")

    async def control_center(self) -> None:
        await self._record("control_center")

    async def skip_forward(self, time_interval: float = 0.0) -> None:
        await self._record("skip_forward")

    async def skip_backward(self, time_interval: float = 0.0) -> None:
        await self._record("skip_backward")

    async def set_position(self, pos: int) -> None:
        await self._record("set_position", pos)


class FakeMetadata(_Recorder):
    IMITATES = "interface.Metadata"

    def __init__(self) -> None:
        super().__init__()
        self.fake_playing = FakePlaying()
        self.fake_app: Optional[FakeApp] = FakeApp("TV", "com.apple.TVWatchList")
        self.fake_app_error: Optional[BaseException] = None

    async def playing(self) -> FakePlaying:
        await self._record("playing")
        return self.fake_playing

    @property
    def app(self) -> Optional[FakeApp]:
        if self.fake_app_error is not None:
            raise self.fake_app_error
        return self.fake_app


class FakePushUpdater(_StateProducer):
    IMITATES = "interface.PushUpdater"

    def __init__(self) -> None:
        super().__init__()
        self.fake_started = False

    @property
    def active(self) -> bool:
        return self.fake_started

    def start(self, initial_delay: int = 0) -> None:
        self.fake_started = True

    def stop(self) -> None:
        self.fake_started = False


class FakeCompanionAPI(_Recorder):
    """Imitates pyatv.protocols.companion.api.CompanionAPI (checked by its own B3 test).

    `fake_attention` overrides what FetchAttentionState answers; by default it agrees with the power state.
    """

    def __init__(self, power: "FakePower") -> None:
        super().__init__()
        self._power = power
        self.fake_attention: Optional[SystemStatus] = None

    async def fetch_attention_state(self) -> SystemStatus:
        await self._record("fetch_attention_state")
        if self.fake_attention is not None:
            return self.fake_attention
        return SystemStatus.Asleep if self._power.fake_state == PowerState.Off else SystemStatus.Awake


class FakeCompanionPower:
    """Imitates pyatv.protocols.companion.CompanionPower, reached through the facade's `_interfaces`."""

    def __init__(self, power: "FakePower") -> None:
        self.api = FakeCompanionAPI(power)


class FakePower(_StateProducer, _Recorder):
    IMITATES = "interface.Power"

    def __init__(self) -> None:
        _StateProducer.__init__(self)
        _Recorder.__init__(self)
        self.fake_state = PowerState.On
        self._interfaces = {Protocol.Companion: FakeCompanionPower(self)}
        self.fake_companion = self._interfaces[Protocol.Companion].api

    @property
    def power_state(self) -> PowerState:
        return self.fake_state

    async def turn_on(self, await_new_state: bool = False) -> None:
        await self._record("turn_on", await_new_state=await_new_state)

    async def turn_off(self, await_new_state: bool = False) -> None:
        await self._record("turn_off", await_new_state=await_new_state)


class FakeAudio(_StateProducer, _Recorder):
    IMITATES = "interface.Audio"

    def __init__(self) -> None:
        _StateProducer.__init__(self)
        _Recorder.__init__(self)
        self.fake_volume: float = 35.0
        self.fake_volume_error: Optional[BaseException] = None

    @property
    def volume(self) -> float:
        if self.fake_volume_error is not None:
            raise self.fake_volume_error
        return self.fake_volume

    async def set_volume(self, level: float) -> None:
        await self._record("set_volume", level)
        self.fake_volume = float(level)


class FakeKeyboard(_StateProducer, _Recorder):
    IMITATES = "interface.Keyboard"

    def __init__(self) -> None:
        _StateProducer.__init__(self)
        _Recorder.__init__(self)
        self.fake_focus = KeyboardFocusState.Unfocused
        self.fake_text: Optional[str] = None

    @property
    def text_focus_state(self) -> KeyboardFocusState:
        return self.fake_focus

    async def text_get(self) -> Optional[str]:
        await self._record("text_get")
        return self.fake_text

    async def text_set(self, text: str) -> None:
        await self._record("text_set", text)
        self.fake_text = text

    async def text_append(self, text: str) -> None:
        await self._record("text_append", text)
        self.fake_text = (self.fake_text or "") + text

    async def text_clear(self) -> None:
        await self._record("text_clear")
        self.fake_text = ""


class FakeApps(_Recorder):
    IMITATES = "interface.Apps"

    def __init__(self) -> None:
        super().__init__()
        self.fake_list = [FakeApp("TV", "com.apple.TVWatchList"), FakeApp("Netflix", "com.netflix.Netflix")]

    async def app_list(self) -> List[FakeApp]:
        await self._record("app_list")
        return list(self.fake_list)

    async def launch_app(self, bundle_id_or_url: str) -> None:
        await self._record("launch_app", bundle_id_or_url)


class FakeAppleTV(_StateProducer):
    IMITATES = "interface.AppleTV"

    def __init__(self, config: FakeConfig) -> None:
        super().__init__()
        self.fake_config = config
        self.fake_closed = False
        self._remote_control = FakeRemoteControl()
        self._metadata = FakeMetadata()
        self._push_updater = FakePushUpdater()
        self._power = FakePower()
        self._audio = FakeAudio()
        self._keyboard = FakeKeyboard()
        self._apps = FakeApps()
        self._features = FakeFeatures()

    remote_control = property(lambda self: self._remote_control)
    metadata = property(lambda self: self._metadata)
    push_updater = property(lambda self: self._push_updater)
    power = property(lambda self: self._power)
    audio = property(lambda self: self._audio)
    keyboard = property(lambda self: self._keyboard)
    apps = property(lambda self: self._apps)
    features = property(lambda self: self._features)

    @property
    def device_info(self) -> FakeDeviceInfo:
        return self.fake_config.device_info

    def close(self) -> set:
        self.fake_closed = True
        return set()


class FakePairingHandler:
    IMITATES = "interface.PairingHandler"

    def __init__(self, config: FakeConfig, protocol: Protocol, name: Optional[str], expected_pin: int) -> None:
        self.fake_config = config
        self.fake_protocol = protocol
        self.fake_name = name
        self.fake_expected_pin = expected_pin
        self.fake_pin: Optional[int] = None
        self.fake_begun = False
        self.fake_closed = False
        self.fake_begin_error: Optional[BaseException] = None
        self.fake_finish_error: Optional[BaseException] = None
        self._has_paired = False
        self._service = config.get_service(protocol)

    @property
    def service(self) -> FakeService:
        return self._service

    @property
    def has_paired(self) -> bool:
        return self._has_paired

    @property
    def device_provides_pin(self) -> bool:
        return True

    def pin(self, pin: int) -> None:
        self.fake_pin = pin

    async def begin(self) -> None:
        self.fake_begun = True
        if self.fake_begin_error is not None:
            raise self.fake_begin_error

    async def finish(self) -> None:
        if self.fake_finish_error is not None:
            raise self.fake_finish_error
        if self.fake_pin == self.fake_expected_pin:
            self._service.credentials = f"{self.fake_protocol.name.lower()}-creds"
            self._has_paired = True

    async def close(self) -> None:
        self.fake_closed = True


class FakePyatv:
    """Module-like: `scan`, `connect`, `pair`, `const`, `exceptions` imitate the pyatv package."""

    const = const
    exceptions = exceptions

    def __init__(self) -> None:
        self.fake_devices: List[FakeConfig] = [FakeConfig()]
        self.fake_scans: List[Dict[str, Any]] = []
        self.fake_connect_error: Optional[BaseException] = None
        self.fake_connected: List[FakeAppleTV] = []
        self.fake_connected_configs: List[FakeConfig] = []
        self.fake_pairings: List[FakePairingHandler] = []
        self.fake_pin = 1234
        self.fake_pair_begin_error: Optional[BaseException] = None
        self.fake_playing_error_on_connect: Optional[BaseException] = None

    async def scan(self, loop: asyncio.AbstractEventLoop, timeout: int = 5, identifier: Any = None,
                   protocol: Any = None, hosts: Optional[List[str]] = None) -> List[FakeConfig]:
        self.fake_scans.append({"timeout": timeout, "identifier": identifier, "hosts": hosts})
        found = [c for c in self.fake_devices if hosts is None or c.address in hosts]
        if identifier is not None:
            wanted = {identifier} if isinstance(identifier, str) else set(identifier)
            found = [c for c in found if wanted & set(c.all_identifiers)]
        return found

    async def connect(self, config: FakeConfig, loop: asyncio.AbstractEventLoop, protocol: Any = None) -> FakeAppleTV:
        self.fake_connected_configs.append(config)
        if self.fake_connect_error is not None:
            raise self.fake_connect_error
        atv = FakeAppleTV(config)
        if self.fake_playing_error_on_connect is not None:
            atv.metadata.fake_errors["playing"] = self.fake_playing_error_on_connect
        self.fake_connected.append(atv)
        return atv

    async def pair(self, config: FakeConfig, protocol: Protocol, loop: asyncio.AbstractEventLoop,
                   **kwargs: Any) -> FakePairingHandler:
        handler = FakePairingHandler(config, protocol, kwargs.get("name"), self.fake_pin)
        handler.fake_begin_error = self.fake_pair_begin_error
        self.fake_pairings.append(handler)
        return handler

    @property
    def fake_atv(self) -> FakeAppleTV:
        return self.fake_connected[-1]
