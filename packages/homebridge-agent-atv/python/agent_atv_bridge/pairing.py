"""Pairing sessions keyed by pairingId, closed after a TTL (DESIGN.md §2.4 pair.*)."""

from __future__ import annotations

import asyncio
import logging
import secrets
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional, Set

from .errors import BridgeError

_LOGGER = logging.getLogger("agent_atv_bridge.pairing")


@dataclass
class PairingSession:
    pairing_id: str
    device: str
    protocol: str
    handler: Any
    close: Callable[[], Awaitable[None]]
    expiry: Optional[asyncio.TimerHandle] = field(default=None, repr=False)


class PairingSessions:
    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._sessions: Dict[str, PairingSession] = {}
        self._expired: Set[str] = set()

    def ensure_none_active(self, device: str) -> None:
        for session in self._sessions.values():
            if session.device == device:
                raise BridgeError(
                    "PAIRING_IN_PROGRESS",
                    f"A pairing is already in progress for {device}",
                    {"pairingId": session.pairing_id},
                )

    def add(self, device: str, protocol: str, handler: Any, close: Callable[[], Awaitable[None]]) -> PairingSession:
        pairing_id = "p-" + secrets.token_hex(6)
        session = PairingSession(pairing_id, device, protocol, handler, close)
        session.expiry = asyncio.get_running_loop().call_later(self._ttl_s, self._expire, pairing_id)
        self._sessions[pairing_id] = session
        return session

    def take(self, pairing_id: str) -> PairingSession:
        """Remove and return the session; the caller must close it."""
        session = self._sessions.pop(pairing_id, None)
        if session is None:
            if pairing_id in self._expired:
                raise BridgeError("PAIRING_EXPIRED", f"Pairing {pairing_id} expired")
            raise BridgeError("PAIRING_NOT_FOUND", f"Pairing {pairing_id} was not found")
        if session.expiry is not None:
            session.expiry.cancel()
        return session

    async def cancel(self, pairing_id: str) -> None:
        try:
            session = self.take(pairing_id)
        except BridgeError:
            return
        await _close_quietly(session)

    async def close_all(self) -> None:
        for pairing_id in list(self._sessions):
            await self.cancel(pairing_id)

    def _expire(self, pairing_id: str) -> None:
        session = self._sessions.pop(pairing_id, None)
        if session is None:
            return
        self._expired.add(pairing_id)
        asyncio.ensure_future(_close_quietly(session))


async def _close_quietly(session: PairingSession) -> None:
    try:
        await session.close()
    except Exception:
        _LOGGER.warning("Closing pairing %s failed", session.pairing_id, exc_info=True)
