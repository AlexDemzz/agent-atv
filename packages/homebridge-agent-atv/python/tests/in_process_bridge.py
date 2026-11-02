"""Runs a JSON-lines serve() in-process over an asyncio.StreamReader and a collecting writer (seams B2 and W1)."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Dict, List, Optional

from agent_atv_bridge.server import serve


class _CollectingWriter:
    def __init__(self) -> None:
        self.messages: List[Dict[str, Any]] = []
        self.changed = asyncio.Event()

    def write(self, data: bytes) -> None:
        for line in data.splitlines():
            self.messages.append(json.loads(line))
        self.changed.set()

    async def drain(self) -> None:
        pass


class InProcessBridge:
    def __init__(self, backend: Any, serve_fn: Callable[..., Any] = serve) -> None:
        self.reader = asyncio.StreamReader()
        self.writer = _CollectingWriter()
        self.task = asyncio.ensure_future(serve_fn(backend, self.reader, self.writer))
        self._next_id = 1
        self._seen_events = 0

    async def _until(self, find: Callable[[], Optional[Dict[str, Any]]], timeout: float) -> Dict[str, Any]:
        async def poll() -> Dict[str, Any]:
            while True:
                found = find()
                if found is not None:
                    return found
                self.writer.changed.clear()
                await self.writer.changed.wait()

        return await asyncio.wait_for(poll(), timeout)

    def send(self, method: str, params: Optional[Dict[str, Any]] = None) -> int:
        request_id = self._next_id
        self._next_id += 1
        line = json.dumps({"id": request_id, "method": method, "params": params or {}}).encode() + b"\n"
        self.reader.feed_data(line)
        return request_id

    async def response(self, request_id: int, timeout: float = 2.0) -> Dict[str, Any]:
        return await self._until(
            lambda: next((m for m in self.writer.messages if m.get("id") == request_id and "event" not in m), None),
            timeout,
        )

    async def request(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 2.0) -> Dict[str, Any]:
        return await self.response(self.send(method, params), timeout)

    async def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        response = await self.request(method, params)
        if not response["ok"]:
            raise AssertionError(f"{method} failed: {response['error']}")
        return response["result"]

    async def error(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 2.0) -> Dict[str, Any]:
        response = await self.request(method, params, timeout)
        if response["ok"]:
            raise AssertionError(f"{method} unexpectedly succeeded: {response['result']}")
        return response["error"]

    def events(self, name: Optional[str] = None) -> List[Dict[str, Any]]:
        return [m for m in self.writer.messages if "event" in m and (name is None or m["event"] == name)]

    def mark_events_seen(self) -> None:
        self._seen_events = len(self.events())

    async def next_event(self, name: str, timeout: float = 2.0) -> Dict[str, Any]:
        """The first `name` event after the last mark_events_seen()/next_event() call."""

        def find() -> Optional[Dict[str, Any]]:
            fresh = self.events()[self._seen_events:]
            for index, event in enumerate(fresh):
                if event["event"] == name:
                    self._seen_events += index + 1
                    return event
            return None

        return await self._until(find, timeout)

    async def close(self) -> None:
        self.reader.feed_eof()
        await asyncio.wait_for(self.task, 5)
