"""Screenshot output: the Apple TV's PNG as captured, or scaled down and re-encoded with Pillow (DESIGN.md §6.2)."""

from __future__ import annotations

import io
import os
from typing import Any, Dict, Optional, Tuple

from agent_atv_bridge.errors import BridgeError

FORMATS = ("png", "jpeg")


def options(params: Dict[str, Any]) -> Tuple[Optional[int], str]:
    return params.get("maxWidth"), params.get("format") or "png"


def encode(png: bytes, max_width: Optional[int], fmt: str) -> bytes:
    """Never upscales; returns `png` untouched when it is already what was asked for."""
    if fmt == "png" and max_width is None:
        return png
    try:
        from PIL import Image
    except ImportError as exc:
        raise BridgeError(
            "SCREEN_FAILED",
            "Pillow is missing from the screen venv: capture without maxWidth and format, or recreate the venv"
            " (python.forceVenvRecreate in the plugin settings, then restart Homebridge)",
            {"exception": type(exc).__name__},
        ) from exc
    with Image.open(io.BytesIO(png)) as image:
        if fmt == "png" and image.width <= max_width:
            return png
        if max_width is not None and image.width > max_width:
            image.thumbnail((max_width, image.height))
        out = io.BytesIO()
        if fmt == "jpeg":
            image.convert("RGB").save(out, "JPEG")
        else:
            image.save(out, "PNG")
        return out.getvalue()


def write_private(path: str, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as out:
        out.write(data)
