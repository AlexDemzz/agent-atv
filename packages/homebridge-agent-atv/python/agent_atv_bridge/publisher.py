"""Debounced, polled State change emission (DESIGN.md §2.3)."""

from __future__ import annotations

import asyncio
import copy
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

_LOGGER = logging.getLogger("agent_atv_bridge.publisher")


@dataclass(frozen=True)
class Timings:
    debounce_s: float = 0.1
    poll_s: float = 1.0
    position_only_s: float = 5.0
    pairing_ttl_s: float = 90.0
    # Below the plugin's 10 s timeouts (DESIGN.md §2.4) so a hung call answers DEVICE_TIMEOUT first.
    call_timeout_s: float = 8.0
    connect_timeout_s: float = 25.0
    # Measured on tvOS 27.2: the pushed power state flips 6 to 7.5 s after turn_on, within 1.5 s after turn_off.
    power_on_wait_s: float = 20.0
    power_off_wait_s: float = 10.0
    # Companion's own request timeout is 5 s; this lets it answer first.
    probe_timeout_s: float = 6.0
    probe_s: float = 60.0
    probe_grace_s: float = 3.0


def _without_position(state: Dict[str, Any]) -> Dict[str, Any]:
    stripped = dict(state)
    stripped["playing"] = {k: v for k, v in state["playing"].items() if k != "position"}
    return stripped


class StatePublisher:
    """Emits `compute()` whenever it differs from the last emitted State.

    A change in playing.position alone is emitted at most once every `position_only_s`.
    """

    def __init__(
        self,
        compute: Callable[[], Dict[str, Any]],
        emit: Callable[[Dict[str, Any]], None],
        timings: Timings,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._compute = compute
        self._emit = emit
        self._timings = timings
        self._clock = clock
        self._last: Optional[Dict[str, Any]] = None
        self._last_at = 0.0
        self._debounce: Optional[asyncio.TimerHandle] = None
        self._poll: Optional[asyncio.Task] = None

    def start(self) -> None:
        self.check()
        self._poll = asyncio.ensure_future(self._poll_forever())

    def notify(self) -> None:
        if self._debounce is None:
            loop = asyncio.get_running_loop()
            self._debounce = loop.call_later(self._timings.debounce_s, self._debounced)

    def _debounced(self) -> None:
        self._debounce = None
        self.check()

    async def _poll_forever(self) -> None:
        while True:
            await asyncio.sleep(self._timings.poll_s)
            self.check()

    def check(self) -> None:
        try:
            state = self._compute()
        except Exception:
            _LOGGER.exception("Could not compute state")
            return
        if state == self._last:
            return
        now = self._clock()
        position_only = self._last is not None and _without_position(state) == _without_position(self._last)
        if position_only and now - self._last_at < self._timings.position_only_s:
            return
        self._last = copy.deepcopy(state)
        self._last_at = now
        self._emit(copy.deepcopy(state))

    def stop(self) -> None:
        if self._debounce is not None:
            self._debounce.cancel()
            self._debounce = None
        if self._poll is not None:
            self._poll.cancel()
            self._poll = None
