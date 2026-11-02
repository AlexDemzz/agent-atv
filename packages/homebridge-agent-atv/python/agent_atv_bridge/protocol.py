"""Line parsing, serialization and request validation (DESIGN.md §2.2). No pyatv import."""

from __future__ import annotations

import json
from dataclasses import dataclass
import re
from typing import Any, Dict, Optional

from .errors import BridgeError
from .keys import INPUT_ACTIONS, KEYS, supports_action


@dataclass
class Request:
    id: int
    method: str
    params: Dict[str, Any]


class InvalidRequest(Exception):
    def __init__(self, request_id: Optional[int], error: BridgeError) -> None:
        super().__init__(error.message)
        self.request_id = request_id
        self.error = error


def _is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def parse_request(line: bytes) -> Request:
    try:
        message = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        raise InvalidRequest(None, BridgeError("BAD_REQUEST", "Request line is not valid JSON")) from None
    if not isinstance(message, dict):
        raise InvalidRequest(None, BridgeError("BAD_REQUEST", "Request must be a JSON object"))
    request_id = message.get("id")
    readable_id = request_id if _is_positive_int(request_id) else None
    if readable_id is None:
        raise InvalidRequest(None, BridgeError("BAD_REQUEST", "Request id must be a positive integer", {"field": "id"}))
    method = message.get("method")
    if not isinstance(method, str):
        raise InvalidRequest(readable_id, BridgeError("BAD_REQUEST", "Request method must be a string", {"field": "method"}))
    params = message.get("params")
    if not isinstance(params, dict):
        raise InvalidRequest(readable_id, BridgeError("BAD_REQUEST", "Request params must be an object", {"field": "params"}))
    return Request(readable_id, method, params)


class _Field:
    def __init__(self, name: str, check, expected: str, required: bool = True) -> None:
        self.name = name
        self.check = check
        self.expected = expected
        self.required = required


def _int(minimum: Optional[int] = None):
    return lambda v: isinstance(v, int) and not isinstance(v, bool) and (minimum is None or v >= minimum)


def _number(minimum: float, maximum: float):
    return lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and minimum <= v <= maximum


def _str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(item, str) for item in v)


def _credentials(v: Any) -> bool:
    return (
        isinstance(v, dict)
        and isinstance(v.get("companion"), str)
        and isinstance(v.get("airplay", ""), (str, type(None)))
    )


_DEVICE = _Field("device", lambda v: isinstance(v, str) and v != "", "a device id")
_TEXT = _Field("text", lambda v: isinstance(v, str), "a string")
_PROTOCOL = _Field("protocol", lambda v: v in ("companion", "airplay"), "companion or airplay")
_PAIRING_ID = _Field("pairingId", lambda v: isinstance(v, str) and v != "", "a pairing id")
_ADDRESS = _Field("address", lambda v: isinstance(v, str), "a string", required=False)

METHOD_PARAMS: Dict[str, list] = {
    "ping": [],
    "shutdown": [],
    "scan": [
        _Field("timeoutMs", _int(1), "a positive integer", required=False),
        _Field("hosts", _str_list, "an array of strings", required=False),
    ],
    "disconnect": [_DEVICE],
    "state": [_DEVICE, _Field("refresh", lambda v: isinstance(v, bool), "a boolean", required=False)],
    "key": [
        _DEVICE,
        _Field("key", lambda v: v in KEYS, "one of " + ", ".join(KEYS)),
        _Field("action", lambda v: v in INPUT_ACTIONS, "tap, double or hold", required=False),
    ],
    "apps.list": [_DEVICE],
    "app.launch": [_DEVICE, _Field("target", lambda v: isinstance(v, str) and v != "", "a bundle id or URL")],
    "keyboard.get": [_DEVICE],
    "keyboard.set": [_DEVICE, _TEXT],
    "keyboard.append": [_DEVICE, _TEXT],
    "keyboard.clear": [_DEVICE],
    "power.set": [_DEVICE, _Field("on", lambda v: isinstance(v, bool), "a boolean")],
    "volume.set": [_DEVICE, _Field("level", _number(0, 100), "a number from 0 to 100")],
    "seek": [_DEVICE, _Field("position", _int(0), "an integer number of seconds >= 0")],
    "pair.begin": [_DEVICE, _ADDRESS, _PROTOCOL, _Field("remoteName", lambda v: isinstance(v, str) and v != "", "a non-empty string")],
    "pair.pin": [_PAIRING_ID, _Field("pin", lambda v: isinstance(v, str) and re.fullmatch(r"\d{4}", v) is not None, "4 digits")],
    "pair.cancel": [_PAIRING_ID],
    "pair.verify": [_DEVICE, _ADDRESS, _PROTOCOL, _Field("credentials", lambda v: isinstance(v, str) and v != "", "a credentials string")],
    "connect": [_DEVICE, _ADDRESS, _Field("credentials", _credentials, "an object with string companion and optional airplay credentials")],
}


def validate_params(method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Return params once every field of `method` is valid; raise BAD_REQUEST naming the first bad field."""
    for field in METHOD_PARAMS[method]:
        if field.name not in params or params[field.name] is None:
            if field.required:
                raise BridgeError("BAD_REQUEST", f"Missing param {field.name}", {"field": field.name})
            continue
        if not field.check(params[field.name]):
            raise BridgeError("BAD_REQUEST", f"Param {field.name} must be {field.expected}", {"field": field.name})
    if method == "key" and not supports_action(params["key"], params.get("action") or "tap"):
        raise BridgeError("BAD_REQUEST", f"Key {params['key']} only supports tap", {"field": "action"})
    return params


def serialize(message: Dict[str, Any]) -> bytes:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"


def success(request_id: int, result: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": request_id, "ok": True, "result": result}


def failure(request_id: Optional[int], error: BridgeError) -> Dict[str, Any]:
    return {"id": request_id, "ok": False, "error": error.to_dict()}
