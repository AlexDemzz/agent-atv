"""Queues the userspace tunnel's inbound packets instead of dropping them (DESIGN.md §6.1 Tunnel).

pymobiledevice3 11.49.1 asks for 6 MiB socketpair buffers, but without root Linux caps them at
net.core.wmem_max (212992 on a Pi), about 26 packets of 16 KB. UserspaceTun.write drops whatever
does not fit, and a screenshot burst then costs about 40 drops, hundreds of retransmitted segments
and RTO stalls: 9 s instead of 3.5 s for a home-screen PNG. This replaces write() with one that
queues what does not fit and sends it, in order, once the socket is writable again.
"""

from __future__ import annotations

import asyncio
import collections
import errno
import logging
from typing import Any, Deque

_LOGGER = logging.getLogger("agent_atv_screen.pmd3")

# 8 MiB of 16 KB packets; a capture queued at most 89 of them on a Pi. Past it TCP recovers the drops.
MAX_QUEUED = 512
_QUEUE = "_agent_atv_queue"
_FULL = (errno.EAGAIN, errno.EWOULDBLOCK, errno.ENOBUFS)


def install(userspace_tunnel: Any) -> None:
    tun_class = userspace_tunnel.UserspaceTun
    if getattr(tun_class.write, "queues_inbound", False):
        return
    loopback, ethernet = userspace_tunnel.LOOPBACK_HEADER, userspace_tunnel._ETH_HDR_TO_STACK
    stock_close = tun_class.close

    def write(self: Any, data: bytes) -> None:
        ipv6 = data[len(loopback) :] if data[: len(loopback)] == loopback else data
        _send(self, ethernet + ipv6)

    async def close(self: Any) -> None:
        # The socketpair closes under the writer otherwise, and its descriptor gets reused.
        _discard(self)
        await stock_close(self)

    write.queues_inbound = True  # type: ignore[attr-defined]
    tun_class.write = write
    tun_class.close = close


def _send(tun: Any, frame: bytes) -> None:
    queue: Deque[bytes] = getattr(tun, _QUEUE, None) or collections.deque()
    if queue:
        if len(queue) < MAX_QUEUED:
            queue.append(frame)
        elif not getattr(tun, "_agent_atv_dropped", False):
            tun._agent_atv_dropped = True
            _LOGGER.debug("The tunnel's inbound queue is full (%d packets); dropping until it drains", MAX_QUEUED)
        return
    try:
        tun._peer.send(frame)
        return
    except OSError as exc:
        if exc.errno not in _FULL:
            _failed(tun, exc)
            return
    queue.append(frame)
    setattr(tun, _QUEUE, queue)
    asyncio.get_running_loop().add_writer(tun._peer.fileno(), _flush, tun)


def _flush(tun: Any) -> None:
    queue: Deque[bytes] = getattr(tun, _QUEUE)
    while queue:
        try:
            tun._peer.send(queue[0])
        except OSError as exc:
            if exc.errno in _FULL:
                return
            _failed(tun, exc)
            _discard(tun)
            return
        queue.popleft()
    _discard(tun)


def _failed(tun: Any, exc: OSError) -> None:
    # Like the stock write(): any other error (e.g. EMSGSIZE) recurs on every retransmission.
    if not tun._send_error_logged:
        tun._send_error_logged = True
        _LOGGER.warning("The userspace tunnel dropped a packet from the Apple TV: %s", exc)


def _discard(tun: Any) -> None:
    queue = getattr(tun, _QUEUE, None)
    if queue is None:
        return
    setattr(tun, _QUEUE, None)
    tun._agent_atv_dropped = False
    if tun._peer.fileno() >= 0:
        asyncio.get_running_loop().remove_writer(tun._peer.fileno())
