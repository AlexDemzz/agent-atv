"""BridgeError and the exception → error code mapping (DESIGN.md §2.9)."""

from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, Iterable, Optional


class BridgeError(Exception):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


ACCESS_DENIED_MARKER = "Failed to set up remote control channel"
DEFAULT_BACKOFF_SEC = 30
AUTH_EXCEPTIONS = ("AuthenticationError", "InvalidCredentialsError", "NoCredentialsError")


def exception_classes(exceptions: Any, *names: str) -> tuple:
    """The named classes of pyatv's exceptions module, skipping names it doesn't define."""
    return tuple(getattr(exceptions, name) for name in names if isinstance(getattr(exceptions, name, None), type))


def _is(exc: BaseException, exceptions: Any, *names: str) -> bool:
    classes = exception_classes(exceptions, *names)
    return bool(classes) and isinstance(exc, classes)


def _pyatv_exception_classes(exceptions: Any) -> tuple:
    return tuple(v for v in vars(exceptions).values() if isinstance(v, type) and issubclass(v, BaseException))


def _redact(message: str, secrets: Iterable[str]) -> str:
    for secret in secrets:
        if secret:
            message = message.replace(secret, "<redacted>")
    return message


def map_exception(
    exc: BaseException,
    exceptions: Any,
    *,
    during_connect: bool = False,
    feature: Optional[str] = None,
    secrets: Iterable[str] = (),
) -> BridgeError:
    """Translate an exception raised by pyatv into a BridgeError (DESIGN.md §2.9)."""
    if isinstance(exc, BridgeError):
        return exc
    name = type(exc).__name__
    message = _redact(str(exc) or name, list(secrets))
    if isinstance(exc, asyncio.TimeoutError) or _is(exc, exceptions, "OperationTimeoutError"):
        return BridgeError("DEVICE_TIMEOUT", f"The Apple TV did not answer in time: {message}")
    if _is(exc, exceptions, "NotSupportedError"):
        return BridgeError("NOT_SUPPORTED", f"Not supported by this Apple TV: {message}", {"feature": feature or message})
    if _is(exc, exceptions, "InvalidResponseError") and ACCESS_DENIED_MARKER in str(exc):
        return BridgeError("ACCESS_DENIED", f"The Apple TV refused remote control: {message}")
    if _is(exc, exceptions, "PairingError"):
        if "BackOff" in str(exc):
            match = re.search(r"BackOff=(\d+)", str(exc))
            retry_after = int(match.group(1)) if match else DEFAULT_BACKOFF_SEC
            return BridgeError("PAIRING_BACKOFF", f"The Apple TV asks to wait before pairing again: {message}", {"retryAfterSec": retry_after})
        return BridgeError("PAIRING_FAILED", f"Pairing failed: {message}")
    if during_connect and _is(exc, exceptions, *AUTH_EXCEPTIONS):
        return BridgeError("AUTH_FAILED", f"The Apple TV rejected the credentials: {message}")
    pyatv_classes = _pyatv_exception_classes(exceptions)
    if (pyatv_classes and isinstance(exc, pyatv_classes)) or isinstance(exc, OSError):
        return BridgeError("DEVICE_ERROR", f"{name}: {message}", {"exception": name})
    return BridgeError("INTERNAL", f"Bridge bug: {name}: {message}", {"exception": name})
