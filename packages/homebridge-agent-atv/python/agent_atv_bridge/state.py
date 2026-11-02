"""Builds the State dict (DESIGN.md §2.5)."""

from __future__ import annotations

from typing import Any, Dict, Optional


def idle_playing() -> Dict[str, Any]:
    return {
        "state": "idle",
        "mediaType": "unknown",
        "title": None,
        "artist": None,
        "album": None,
        "seriesName": None,
        "season": None,
        "episode": None,
        "position": None,
        "totalTime": None,
    }


_OS_NAMES = {"TvOS": "tvOS", "MacOS": "macOS", "AirPortOS": "AirPortOS", "Legacy": "Legacy"}


def enum_name(value: Any, default: str = "unknown") -> str:
    name = getattr(value, "name", None)
    return name.lower() if isinstance(name, str) else default


def os_name(operating_system: Any) -> str:
    return _OS_NAMES.get(getattr(operating_system, "name", ""), "unknown")


def format_mac(mac: Optional[str]) -> Optional[str]:
    if not mac:
        return None
    digits = "".join(ch for ch in mac if ch.isalnum()).upper()
    if len(digits) != 12:
        return mac.upper()
    return ":".join(digits[i : i + 2] for i in range(0, 12, 2))


def device_id(config: Any) -> str:
    """The MAC without separators, else pyatv's identifier (DESIGN.md §2.7)."""
    mac = format_mac(config.device_info.mac)
    if mac:
        return mac.replace(":", "")
    return str(config.identifier)


def device_summary(config: Any, device_info: Any = None) -> Dict[str, Any]:
    info = device_info or config.device_info
    return {
        "id": device_id(config),
        "name": config.name,
        "model": info.model_str,
        "os": os_name(info.operating_system),
        "version": info.version,
        "address": str(config.address),
        "mac": format_mac(config.device_info.mac),
    }


def scan_device(config: Any) -> Dict[str, Any]:
    summary = device_summary(config)
    return {
        "id": summary["id"],
        "name": summary["name"],
        "address": summary["address"],
        "mac": summary["mac"],
        "model": summary["model"],
        "os": summary["os"],
        "version": summary["version"],
        "identifiers": list(config.all_identifiers),
        "services": [
            {"protocol": enum_name(service.protocol), "port": service.port, "pairing": enum_name(service.pairing)}
            for service in config.services
        ],
    }


def _read(read: Any, default: Any = None) -> Any:
    """pyatv raises (NotSupportedError, BlockedStateError, …) for unavailable features."""
    try:
        return read()
    except Exception:
        return default


def playing_state(playing: Any) -> Dict[str, Any]:
    if playing is None:
        return idle_playing()
    return {
        "state": enum_name(playing.device_state, "idle"),
        "mediaType": enum_name(playing.media_type),
        "title": playing.title,
        "artist": playing.artist,
        "album": playing.album,
        "seriesName": playing.series_name,
        "season": playing.season_number,
        "episode": playing.episode_number,
        "position": playing.position,
        "totalTime": playing.total_time,
    }


def app_state(app: Any) -> Optional[Dict[str, Any]]:
    if app is None:
        return None
    return {"bundleId": app.identifier, "name": app.name or app.identifier}


def keyboard_focus(atv: Any) -> str:
    return enum_name(_read(lambda: atv.keyboard.text_focus_state))


def feature_unavailable(atv: Any, const: Any, feature: str) -> bool:
    """True only when pyatv positively reports the feature as not available."""
    state = _read(lambda: atv.features.get_feature(getattr(const.FeatureName, feature)).state)
    return state is not None and enum_name(state) != "available"


def build_state(
    atv: Any,
    device: Dict[str, Any],
    protocols: Dict[str, bool],
    playing: Any,
    keyboard_text: Optional[str],
    volume_available: bool = True,
) -> Dict[str, Any]:
    focus = keyboard_focus(atv)
    # Unavailable volume still reads as 0.0 on tvOS (no CEC volume), so the feature state decides.
    volume = _read(lambda: atv.audio.volume) if volume_available else None
    return {
        "device": dict(device),
        "power": enum_name(_read(lambda: atv.power.power_state)),
        # The MRP now-playing client: the last app that played, not the foreground app.
        "nowPlaying": _read(lambda: app_state(atv.metadata.app)),
        "playing": playing_state(playing),
        "keyboard": {"focus": focus, "text": keyboard_text if focus == "focused" else None},
        "volume": int(round(volume)) if isinstance(volume, (int, float)) else None,
        "protocols": dict(protocols),
    }
