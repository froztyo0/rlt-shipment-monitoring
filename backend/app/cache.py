"""Tiny in-process TTL cache so dashboard polling doesn't hammer RDS.

Aggregate endpoints (KPIs, ops lists, filter values) are identical for every
viewer, so serving them from memory for a short window cuts DB load to one
query burst per TTL regardless of how many tabs are open. Per-shipment
endpoints stay uncached (low volume, always fresh).

An asyncio.Lock per key prevents a thundering herd: when the entry expires,
exactly one request recomputes while the rest await the same result.
"""
import asyncio
import time
from typing import Any, Awaitable, Callable

_store: dict[str, tuple[float, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}
_MAX_KEYS = 512


async def cached(key: str, ttl_seconds: float, producer: Callable[[], Awaitable[Any]]) -> Any:
    now = time.monotonic()
    hit = _store.get(key)
    if hit and hit[0] > now:
        return hit[1]
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _store.get(key)  # re-check: another waiter may have filled it
        if hit and hit[0] > time.monotonic():
            return hit[1]
        value = await producer()
        if len(_store) >= _MAX_KEYS:  # bounded: drop expired, then oldest
            expired = [k for k, (exp, _) in _store.items() if exp <= time.monotonic()]
            for k in expired:
                _store.pop(k, None)
                _locks.pop(k, None)
            while len(_store) >= _MAX_KEYS:
                oldest = min(_store, key=lambda k: _store[k][0])
                _store.pop(oldest, None)
                _locks.pop(oldest, None)
        _store[key] = (time.monotonic() + ttl_seconds, value)
        return value
