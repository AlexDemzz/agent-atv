"""serve(backend, reader, writer): the screen worker's stdio protocol loop (DESIGN.md §6.2)."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
from typing import Any, Callable, Dict, Optional, Set

from agent_atv_bridge.errors import BridgeError
from agent_atv_bridge.protocol import InvalidRequest, Request, failure, parse_request, serialize, success

from . import SCREEN_PROTOCOL_VERSION, __version__
from .image import FORMATS

_LOGGER = logging.getLogger("agent_atv_screen.server")

PIN = re.compile(r"\d{4,8}")

_CHECKS: Dict[str, Dict[str, Callable[[Any], bool]]] = {
    "ping": {},
    "shutdown": {},
    "follow": {},
    "focus": {},
    "foreground": {},
    "screenshot": {
        "path": lambda v: isinstance(v, str) and os.path.isabs(v),
        "maxWidth": lambda v: v is None or (type(v) is int and v > 0),
        "format": lambda v: v is None or v in FORMATS,
    },
    "pair.begin": {},
    "pair.pin": {"pin": lambda v: isinstance(v, str) and PIN.fullmatch(v) is not None},
    "pair.cancel": {},
}


def _validate(request: Request) -> None:
    checks = _CHECKS.get(request.method)
    if checks is None:
        raise BridgeError("UNKNOWN_METHOD", f"Unknown method {request.method}", {"method": request.method})
    for name, check in checks.items():
        if not check(request.params.get(name)):
            raise BridgeError("BAD_REQUEST", f"Missing or invalid param {name}", {"field": name})


async def serve(backend: Any, reader: asyncio.StreamReader, writer: Any, *, stop: Optional[asyncio.Event] = None) -> None:
    """Run until stdin EOF, a shutdown request or `stop` is set, then close the backend."""
    stop = stop or asyncio.Event()
    tasks: Set[asyncio.Task] = set()

    def send(message: Dict[str, Any]) -> None:
        writer.write(serialize(message))

    async def handle(request: Request) -> None:
        try:
            _validate(request)
            if request.method == "ping":
                result = {"pong": True, **backend.status()}
            elif request.method == "shutdown":
                stop.set()
                result = {}
            else:
                result = await getattr(backend, request.method.replace(".", "_"))(request.params)
            send(success(request.id, result))
        except BridgeError as error:
            send(failure(request.id, error))
        except Exception as exc:
            _LOGGER.exception("Unexpected error in %s", request.method)
            send(failure(request.id, BridgeError("INTERNAL", f"Worker bug in {request.method}: {exc}", {"exception": type(exc).__name__})))
        await writer.drain()

    backend.bind(lambda name, data: send({"event": name, "data": data}))
    send(
        {
            "event": "ready",
            "data": {
                "protocolVersion": SCREEN_PROTOCOL_VERSION,
                "workerVersion": __version__,
                "python": platform.python_version(),
                "pymobiledevice3": backend.pmd3_version,
                "backend": backend.name,
            },
        }
    )
    await writer.drain()
    await backend.start()
    stopped = asyncio.ensure_future(stop.wait())
    try:
        while not stop.is_set():
            next_line = asyncio.ensure_future(reader.readline())
            await asyncio.wait({next_line, stopped}, return_when=asyncio.FIRST_COMPLETED)
            if not next_line.done():
                next_line.cancel()
                break
            try:
                line = next_line.result()
            except ValueError:
                send(failure(None, BridgeError("BAD_REQUEST", "Request line is too long")))
                continue
            if not line:
                break
            try:
                request = parse_request(line)
            except InvalidRequest as invalid:
                send(failure(invalid.request_id, invalid.error))
                continue
            task = asyncio.ensure_future(handle(request))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        stopped.cancel()
        pending = [task for task in tasks if not task.done()]
        if pending:
            await asyncio.wait(pending, timeout=1.0)
        for task in pending:
            task.cancel()
        try:
            await asyncio.wait_for(backend.close(), timeout=4.0)
        except Exception:
            _LOGGER.exception("Error while closing the screen backend")
        await writer.drain()
