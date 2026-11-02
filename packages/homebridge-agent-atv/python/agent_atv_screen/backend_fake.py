"""A deterministic in-memory screen for tests and development (DESIGN.md §6.4). No pymobiledevice3."""

from __future__ import annotations

import asyncio
import struct
import zlib
from typing import Any, Callable, Dict, Optional

from agent_atv_bridge.errors import BridgeError

from .image import options, write_private

FAKE_IDENTIFIER = "FAKE-REMOTEPAIRING-0001"
FAKE_PIN = "1234"
FAKE_FOCUS = {"label": "Fake focus", "value": None, "identifier": "fake/focus"}


def fake_png(width: int = 1920, height: int = 1080) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def fake_jpeg(width: int, height: int) -> bytes:
    """Just the markers that carry the size: SOI, a baseline SOF0 for 3 components, EOI."""
    sof = struct.pack(">BHHB", 8, height, width, 3) + b"\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    return b"\xff\xd8" + b"\xff\xc0" + struct.pack(">H", len(sof) + 2) + sof + b"\xff\xd9"


class FakeBackend:
    name = "fake"
    pmd3_version = None

    def __init__(self, identifier: Optional[str]) -> None:
        self._identifier = identifier or None
        self._pairing = False
        self._emit: Callable[[str, Dict[str, Any]], None] = lambda name, data: None

    def bind(self, emit: Callable[[str, Dict[str, Any]], None]) -> None:
        self._emit = emit

    async def start(self) -> None:
        self._emit("status", self.status())

    async def close(self) -> None:
        pass

    def status(self) -> Dict[str, Any]:
        tunnel = "connected" if self._identifier else "unpaired"
        return {"tunnel": tunnel, "identifier": self._identifier, "error": None}

    def _require_paired(self) -> None:
        if not self._identifier:
            raise BridgeError("SCREEN_NOT_PAIRED", "No RemotePairing pair record for this Apple TV")

    async def focus(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_paired()
        return {"focus": dict(FAKE_FOCUS), "ageMs": 0}

    async def foreground(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_paired()
        return {"kind": "home"}

    async def screenshot(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._require_paired()
        await asyncio.sleep(0)
        max_width, fmt = options(params)
        width = min(1920, max_width or 1920)
        height = round(1080 * width / 1920)
        data = fake_jpeg(width, height) if fmt == "jpeg" else fake_png(width, height)
        write_private(params["path"], data)
        return {"bytes": len(data)}

    async def pair_begin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._pairing = True
        return {}

    async def pair_pin(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if not self._pairing:
            raise BridgeError("PAIRING_NOT_FOUND", "No RemotePairing is waiting for a PIN; start with pair.begin")
        self._pairing = False
        if params["pin"] != FAKE_PIN:
            raise BridgeError("PAIRING_FAILED", "RemotePairing failed: wrong PIN")
        self._identifier = FAKE_IDENTIFIER
        self._emit("status", self.status())
        return {"identifier": FAKE_IDENTIFIER}

    async def pair_cancel(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self._pairing = False
        return {}
