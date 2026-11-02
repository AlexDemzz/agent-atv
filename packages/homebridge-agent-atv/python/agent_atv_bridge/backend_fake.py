"""In-memory fake Apple TV for tests and development (DESIGN.md §2.8). Must not import pyatv."""

from __future__ import annotations

import asyncio
import copy
import os
import time
from typing import Any, Callable, Dict, Optional

from .errors import BridgeError
from .pairing import PairingSessions
from .publisher import StatePublisher, Timings
from .state import idle_playing

FAKE_ID = "FAKE00000001"
COMPANION_CREDENTIALS = "fake-companion-creds"
AIRPLAY_CREDENTIALS = "fake-airplay-creds"
FAKE_DEVICE = {
    "id": FAKE_ID,
    "name": "Fake Apple TV",
    "model": "Apple TV 4K (gen 3)",
    "os": "tvOS",
    "version": "27.2",
    "address": "127.0.0.1",
    "mac": "FA:KE:00:00:00:01",
}
APPS = {
    "com.apple.TVWatchList": "TV",
    "com.apple.TVSearch": "Search",
    "com.netflix.Netflix": "Netflix",
    "com.google.ios.youtube": "YouTube",
    "com.apple.TVSettings": "Settings",
}
HOME_APP = "com.apple.TVWatchList"
SEARCH_APP = "com.apple.TVSearch"
CREDENTIALS = {"companion": COMPANION_CREDENTIALS, "airplay": AIRPLAY_CREDENTIALS}
CORRECT_PIN = "1234"
BACKOFF_PIN = "0000"
MOVIE = {"mediaType": "video", "title": "Fake Movie", "totalTime": 5400}


class FakeBackend:
    name = "fake"
    pyatv_version = None

    def __init__(self) -> None:
        self.latency_s = int(os.environ.get("AGENT_ATV_FAKE_LATENCY_MS", "0") or 0) / 1000
        self._emit: Callable[[str, Optional[str], Dict[str, Any]], None] = lambda *_: None
        self.power = "on"
        self.app = HOME_APP
        self.keyboard_focus = "unfocused"
        self.keyboard_text: Optional[str] = None
        self.volume = 50
        self.playback = "idle"
        self.position = 0.0
        self.position_clock: Optional[float] = None
        self.connected = False
        self.airplay = False
        self.publisher: Optional[StatePublisher] = None
        self.pairings = PairingSessions(Timings().pairing_ttl_s)

    def bind(self, emit: Callable[[str, Optional[str], Dict[str, Any]], None]) -> None:
        self._emit = emit

    def _state(self) -> Dict[str, Any]:
        app = {"bundleId": self.app, "name": APPS[self.app]} if self.airplay else None
        return {
            "device": dict(FAKE_DEVICE),
            "power": self.power,
            "nowPlaying": app,
            "playing": self._playing(),
            "keyboard": self._keyboard(),
            "volume": self.volume,
            "protocols": {"companion": True, "airplay": self.airplay},
        }

    def _playing(self) -> Dict[str, Any]:
        if self.playback == "idle":
            return idle_playing()
        return {**idle_playing(), **MOVIE, "state": self.playback, "position": int(self._position_now())}

    def _position_now(self) -> float:
        if self.position_clock is None:
            return self.position
        return self.position + time.monotonic() - self.position_clock

    def _set_playback(self, playback: str) -> None:
        self.position = self._position_now() if playback != "idle" else 0.0
        self.position_clock = time.monotonic() if playback == "playing" else None
        self.playback = playback

    def _changed(self) -> None:
        if self.publisher is not None:
            self.publisher.notify()

    def _require_device(self, device: str) -> None:
        if device.upper() != FAKE_ID:
            raise BridgeError("DEVICE_NOT_FOUND", f"Device {device} was not found", {"device": device})

    async def scan(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "devices": [
                {
                    **FAKE_DEVICE,
                    "identifiers": ["FA:KE:00:00:00:01", FAKE_ID],
                    "services": [
                        {"protocol": "companion", "port": 49153, "pairing": "mandatory"},
                        {"protocol": "airplay", "port": 7000, "pairing": "mandatory"},
                    ],
                }
            ]
        }

    async def pair_begin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_device(params["device"])
        self.pairings.ensure_none_active(FAKE_ID)
        session = self.pairings.add(FAKE_ID, params["protocol"], None, _nothing)
        return {"pairingId": session.pairing_id, "protocol": session.protocol, "deviceProvidesPin": True}

    async def pair_pin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session = self.pairings.take(params["pairingId"])
        if params["pin"] == BACKOFF_PIN:
            raise BridgeError("PAIRING_BACKOFF", "Fake Apple TV asks to wait before pairing again", {"retryAfterSec": 30})
        if params["pin"] != CORRECT_PIN:
            raise BridgeError("PAIRING_FAILED", "Wrong PIN")
        return {"protocol": session.protocol, "credentials": CREDENTIALS[session.protocol]}

    async def pair_cancel(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self.pairings.cancel(params["pairingId"])
        return {}

    async def pair_verify(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_device(params["device"])
        return {"valid": params["credentials"] == CREDENTIALS[params["protocol"]]}

    async def connect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_device(params["device"])
        if self.connected:
            return self._state()
        credentials = params["credentials"]
        if credentials["companion"] != COMPANION_CREDENTIALS:
            raise BridgeError("AUTH_FAILED", "Companion credentials were rejected", {"protocol": "companion"})
        airplay = credentials.get("airplay")
        if airplay is not None and airplay != AIRPLAY_CREDENTIALS:
            raise BridgeError("AUTH_FAILED", "AirPlay credentials were rejected", {"protocol": "airplay"})
        self.connected = True
        self.airplay = airplay is not None
        self.publisher = StatePublisher(self._state, lambda state: self._emit("state", FAKE_ID, state), Timings())
        self.publisher.start()
        return self._state()

    def _require_connection(self, device: str) -> None:
        if not self.connected or device.upper() != FAKE_ID:
            raise BridgeError("NOT_CONNECTED", f"Device {device} is not connected", {"device": device})

    def _forget_connection(self) -> None:
        self.connected = False
        if self.publisher is not None:
            self.publisher.stop()
            self.publisher = None

    async def disconnect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._forget_connection()
        return {}

    async def _action(self, device: str, allowed_while_off: bool = False) -> None:
        self._require_connection(device)
        if self.latency_s:
            await asyncio.sleep(self.latency_s)
        if self.power == "off" and not allowed_while_off:
            raise BridgeError("DEVICE_OFF", "Fake Apple TV is off", {})

    async def key(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self._action(params["device"])
        key = params["key"]
        if key == "play_pause":
            self._set_playback("paused" if self.playback == "playing" else "playing")
        elif key == "stop":
            self._set_playback("idle")
        elif key == "home":
            self._open(HOME_APP)
        elif key in ("volume_up", "volume_down"):
            self.volume = max(0, min(100, self.volume + (5 if key == "volume_up" else -5)))
        self._changed()
        return {}

    async def state(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_connection(params["device"])
        return self._state()

    def _open(self, bundle_id: str) -> None:
        self.app = bundle_id
        if bundle_id == SEARCH_APP:
            self.keyboard_focus, self.keyboard_text = "focused", ""
        else:
            self.keyboard_focus, self.keyboard_text = "unfocused", None

    async def apps_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_connection(params["device"])
        apps = [{"bundleId": bundle_id, "name": name} for bundle_id, name in APPS.items()]
        return {"apps": sorted(apps, key=lambda app: app["name"].lower())}

    async def app_launch(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self._action(params["device"])
        target = params["target"]
        if "://" in target:
            return {}
        if target not in APPS:
            raise BridgeError("LAUNCH_FAILED", f"App {target} is not installed", {"target": target})
        self._open(target)
        self._changed()
        return {}

    def _keyboard(self) -> Dict[str, Any]:
        return {"focus": self.keyboard_focus, "text": self.keyboard_text}

    async def _edit_keyboard(self, device: str, text: Callable[[str], str]) -> Dict[str, Any]:
        await self._action(device)
        if self.keyboard_focus != "focused":
            raise BridgeError("KEYBOARD_NOT_FOCUSED", "No text field is focused on Fake Apple TV")
        self.keyboard_text = text(self.keyboard_text or "")
        self._changed()
        return self._keyboard()

    async def keyboard_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_connection(params["device"])
        return self._keyboard()

    async def keyboard_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self._edit_keyboard(params["device"], lambda _: params["text"])

    async def keyboard_append(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self._edit_keyboard(params["device"], lambda current: current + params["text"])

    async def keyboard_clear(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self._edit_keyboard(params["device"], lambda _: "")

    async def power_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self._action(params["device"], allowed_while_off=True)
        self.power = "on" if params["on"] else "off"
        self._changed()
        return {"power": self.power}

    async def volume_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self._action(params["device"])
        self.volume = round(params["level"])
        self._changed()
        return {"volume": self.volume}

    async def seek(self, params: Dict[str, Any]) -> Dict[str, Any]:
        await self._action(params["device"])
        if self.playback != "idle":
            self.position = float(params["position"])
            if self.position_clock is not None:
                self.position_clock = time.monotonic()
            self._changed()
        return {}

    async def close(self) -> None:
        self._forget_connection()
        await self.pairings.close_all()


async def _nothing() -> None:
    pass
