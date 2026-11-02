"""Drives `python -m agent_atv_bridge` (or the screen worker) as a child process over stdio (seams B1, W1)."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

PYTHON_DIR = Path(__file__).resolve().parent.parent


class BridgeProcess:
    def __init__(self, *args: str, env: Optional[Dict[str, str]] = None, module: str = "agent_atv_bridge") -> None:
        child_env = dict(os.environ)
        child_env["PYTHONPATH"] = str(PYTHON_DIR)
        child_env.update(env or {})
        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-m", module, *args],
            cwd=str(PYTHON_DIR),
            env=child_env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._lines: "queue.Queue[Optional[bytes]]" = queue.Queue()
        self.stderr_lines: List[str] = []
        self.events: List[Dict[str, Any]] = []
        self._next_id = 1
        self._threads = [
            threading.Thread(target=self._pump_stdout, daemon=True),
            threading.Thread(target=self._pump_stderr, daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._lines.put(line)
        self._lines.put(None)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr_lines.append(line.decode("utf-8", "replace").rstrip("\n"))

    def next_message(self, timeout: float = 5.0) -> Dict[str, Any]:
        line = self._lines.get(timeout=timeout)
        if line is None:
            raise EOFError("bridge stdout closed")
        return json.loads(line)

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send(self, message: Dict[str, Any]) -> None:
        self.send_raw(json.dumps(message).encode() + b"\n")

    def request(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 5.0) -> Dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        self.send({"id": request_id, "method": method, "params": params if params is not None else {}})
        return self.response_for(request_id, timeout)

    def response_for(self, request_id: Any, timeout: float = 5.0) -> Dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            message = self.next_message(max(0.0, deadline - time.monotonic()))
            if "event" in message:
                self.events.append(message)
            elif message.get("id") == request_id:
                return message

    def wait_event(self, predicate, timeout: float = 5.0) -> Dict[str, Any]:
        for event in self.events:
            if predicate(event):
                self.events.remove(event)
                return event
        deadline = time.monotonic() + timeout
        while True:
            message = self.next_message(max(0.0, deadline - time.monotonic()))
            if "event" in message and predicate(message):
                return message
            if "event" in message:
                self.events.append(message)

    def close_stdin(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=5)
        for thread in self._threads:
            thread.join(timeout=5)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
