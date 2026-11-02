"""Entry point: python -m agent_atv_screen [--fake] [--address IP] [--identifier ID] (DESIGN.md §6.2)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys

from agent_atv_bridge.__main__ import MAX_LINE_BYTES, _LineFormatter, _StdoutWriter

# Under sudo, pymobiledevice3 resolves its home folder (and so the pair records) from these.
SCRUBBED_ENV = ("SUDO_USER", "SUDO_UID", "SUDO_GID", "XDG_DATA_HOME")

_LOGGER = logging.getLogger("agent_atv_screen")


def _setup_logging() -> None:
    debug = os.environ.get("AGENT_ATV_BRIDGE_DEBUG") == "1"
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_LineFormatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    # The plugin logs INFO lines at info level: only the worker's own, which are status changes.
    root.setLevel(logging.DEBUG if debug else logging.WARNING)
    if not debug:
        logging.getLogger("agent_atv_screen").setLevel(logging.INFO)


async def _run(args: argparse.Namespace) -> None:
    from .server import serve

    if args.fake:
        from .backend_fake import FakeBackend

        backend = FakeBackend(args.identifier)
    else:
        for name in SCRUBBED_ENV:
            os.environ.pop(name, None)
        try:
            from .pmd3 import load

            pmd3 = load()
        except ImportError as exc:
            _LOGGER.error("pymobiledevice3 is not installed in %s: %s", sys.executable, exc)
            raise SystemExit(1) from exc
        from .backend_pmd3 import Pmd3Backend

        backend = Pmd3Backend(pmd3, address=args.address, identifier=args.identifier)

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    _LOGGER.debug("Starting with the %s backend", backend.name)
    await serve(backend, reader, _StdoutWriter(), stop=stop)
    _LOGGER.debug("Stopped")


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(prog="agent_atv_screen")
    parser.add_argument("--fake", action="store_true")
    parser.add_argument("--address", default=None, help="the Apple TV's address, preferred among its RemotePairing addresses")
    parser.add_argument("--identifier", default=None, help="the RemotePairing identifier of its pair record")
    _setup_logging()
    asyncio.run(_run(parser.parse_args(argv)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
