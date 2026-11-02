"""Queues the userspace tunnel's inbound packets instead of dropping them (DESIGN.md §6.1 Tunnel).

Without root, Linux caps the tunnel's socketpair buffer far below a screenshot burst, and
UserspaceTun.write drops whatever does not fit, which stalls the capture on retransmissions. This
replaces write() with one that queues what does not fit and sends it, in order, once the socket is
writable again.
"""

from __future__ import annotations

import asyncio
import collections
import errno
import logging
from typing import Any, Deque, Optional

_LOGGER = logging.getLogger("agent_atv_screen.pmd3")

# Bounds the memory a stalled stack can pin; past it TCP recovers the drops.
MAX_QUEUED = 512
_QUEUE = "_agent_atv_queue"
_DROPPING = "_agent_atv_dropping"
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
        # The stock close() sets _closed before it awaits, so no write() can queue again.
        _discard(self)
        await stock_close(self)

    write.queues_inbound = True  # type: ignore[attr-defined]
    tun_class.write = write
    tun_class.close = close


def _send(tun: Any, frame: bytes) -> None:
    queue: Optional[Deque[bytes]] = getattr(tun, _QUEUE, None)
    if queue:
        if len(queue) < MAX_QUEUED:
            queue.append(frame)
        elif not getattr(tun, _DROPPING, False):
            setattr(tun, _DROPPING, True)
            _LOGGER.debug("The tunnel's inbound queue is full (%d packets); dropping until it drains", MAX_QUEUED)
        return
    try:
        tun._peer.send(frame)
        return
    except OSError as exc:
        if exc.errno not in _FULL:
            _failed(tun, exc)
            return
    if tun._closed:
        return
    setattr(tun, _QUEUE, collections.deque((frame,)))
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
        queue.popleft()
    _discard(tun)


def _failed(tun: Any, exc: OSError) -> None:
    # Like the stock write(): any other error (e.g. EMSGSIZE) drops the packet, logged once per tunnel.
    if not tun._send_error_logged:
        tun._send_error_logged = True
        _LOGGER.debug("The userspace tunnel dropped a packet from the Apple TV: %s", exc)


def _discard(tun: Any) -> None:
    if getattr(tun, _QUEUE, None) is None:
        return
    setattr(tun, _QUEUE, None)
    setattr(tun, _DROPPING, False)
    if tun._peer.fileno() >= 0:
        asyncio.get_running_loop().remove_writer(tun._peer.fileno())
