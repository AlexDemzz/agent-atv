"""Entry point: python -m agent_atv_bridge [--fake] (DESIGN.md §2.1)."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

MAX_LINE_BYTES = 4 * 1024 * 1024


class _StdoutWriter:
    def write(self, data: bytes) -> None:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

    async def drain(self) -> None:
        pass


class _LineFormatter(logging.Formatter):
    """`LEVEL logger: message`, one line per record line, so tracebacks stay parseable."""

    def format(self, record: logging.LogRecord) -> str:
        prefix = f"{record.levelname} {record.name}: "
        text = super().format(record)
        return "\n".join(prefix + line if i else line for i, line in enumerate(text.splitlines()))


def _setup_logging() -> None:
    debug = os.environ.get("AGENT_ATV_BRIDGE_DEBUG") == "1"
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_LineFormatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    logging.getLogger("pyatv").setLevel(logging.DEBUG if debug else logging.WARNING)


_LOGGER = logging.getLogger("agent_atv_bridge")


async def _run(fake: bool) -> None:
    from .server import serve

    if fake:
        from .backend_fake import FakeBackend

        backend = FakeBackend()
    else:
        try:
            import pyatv
        except ImportError as exc:
            _LOGGER.error("pyatv is not installed in %s: %s", sys.executable, exc)
            raise SystemExit(1) from exc

        from .backend_pyatv import PyatvBackend

        backend = PyatvBackend(pyatv)

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    _LOGGER.info("Starting with the %s backend", backend.name)
    await serve(backend, reader, _StdoutWriter(), stop=stop)
    _LOGGER.info("Stopped")


def main(argv: list) -> int:
    _setup_logging()
    asyncio.run(_run("--fake" in argv))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
