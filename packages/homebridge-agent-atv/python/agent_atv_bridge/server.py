"""serve(backend, reader, writer): the stdio protocol loop (DESIGN.md §2.1-§2.3)."""

from __future__ import annotations

import asyncio
import logging
import platform
from typing import Any, Dict, Optional, Set

from . import BRIDGE_PROTOCOL_VERSION, __version__
from .errors import BridgeError
from .protocol import METHOD_PARAMS, InvalidRequest, Request, failure, parse_request, serialize, success, validate_params

_LOGGER = logging.getLogger("agent_atv_bridge.server")

ACTION_METHODS = frozenset(
    {"key", "app.launch", "keyboard.set", "keyboard.append", "keyboard.clear", "power.set", "volume.set", "seek"}
)


class _Server:
    def __init__(self, backend: Any, writer: Any, stop: asyncio.Event) -> None:
        self.backend = backend
        self.writer = writer
        self.stop = stop
        self.tasks: Set[asyncio.Task] = set()
        self.device_locks: Dict[str, asyncio.Lock] = {}
        backend.bind(self.event)

    def event(self, name: str, device: Optional[str], data: Dict[str, Any]) -> None:
        message: Dict[str, Any] = {"event": name}
        if device is not None:
            message["device"] = device
        message["data"] = data
        self.send(message)
        task = asyncio.ensure_future(self.flush())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def send(self, message: Dict[str, Any]) -> None:
        self.writer.write(serialize(message))

    async def flush(self) -> None:
        await self.writer.drain()

    def ready(self) -> None:
        self.send(
            {
                "event": "ready",
                "data": {
                    "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                    "bridgeVersion": __version__,
                    "python": platform.python_version(),
                    "pyatv": self.backend.pyatv_version,
                    "backend": self.backend.name,
                },
            }
        )

    def accept(self, line: bytes) -> None:
        try:
            request = parse_request(line)
        except InvalidRequest as invalid:
            self.send(failure(invalid.request_id, invalid.error))
            return
        lock = None
        device = request.params.get("device")
        if request.method in ACTION_METHODS and isinstance(device, str):
            lock = self.device_locks.setdefault(device.upper(), asyncio.Lock())
        task = asyncio.ensure_future(self.handle(request, lock))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def handle(self, request: Request, lock: Optional[asyncio.Lock]) -> None:
        try:
            if lock is None:
                result = await self.dispatch(request)
            else:
                async with lock:
                    result = await self.dispatch(request)
            self.send(success(request.id, result))
        except BridgeError as error:
            self.send(failure(request.id, error))
        except Exception as exc:
            _LOGGER.exception("Unexpected error in %s", request.method)
            self.send(failure(request.id, BridgeError("INTERNAL", f"Bridge bug in {request.method}: {exc}", {"exception": type(exc).__name__})))
        await self.flush()

    async def shutdown(self) -> None:
        pending = [task for task in self.tasks if not task.done()]
        if pending:
            await asyncio.wait(pending, timeout=1.0)
        for task in pending:
            task.cancel()
        try:
            await asyncio.wait_for(self.backend.close(), timeout=4.0)
        except Exception:
            _LOGGER.exception("Error while closing devices")
        try:
            await self.flush()
        except Exception:
            pass

    async def dispatch(self, request: Request) -> Dict[str, Any]:
        if request.method not in METHOD_PARAMS:
            raise BridgeError("UNKNOWN_METHOD", f"Unknown method {request.method}", {"method": request.method})
        params = validate_params(request.method, request.params)
        if request.method == "ping":
            return {"pong": True}
        if request.method == "shutdown":
            self.stop.set()
            return {}
        handler = getattr(self.backend, request.method.replace(".", "_"))
        return await handler(params)


async def serve(backend: Any, reader: asyncio.StreamReader, writer: Any, *, stop: Optional[asyncio.Event] = None) -> None:
    """Run until stdin EOF, a shutdown request or `stop` is set, then close the backend."""
    stop = stop or asyncio.Event()
    server = _Server(backend, writer, stop)
    server.ready()
    await server.flush()
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
                server.send(failure(None, BridgeError("BAD_REQUEST", "Request line is too long")))
                await server.flush()
                continue
            if not line:
                break
            server.accept(line)
            await server.flush()
    finally:
        stopped.cancel()
        await server.shutdown()
