"""Tiny in-process TTL cache so dashboard polling doesn't hammer RDS.

Aggregate endpoints (KPIs, ops lists, filter values) are identical for every
viewer, so serving them from memory for a short window cuts DB load to one
query burst per TTL regardless of how many tabs are open. Per-shipment
endpoints stay uncached (low volume, always fresh).

Guarantees:
- single-flight: one asyncio.Lock per key; when an entry expires exactly one
  request recomputes while the rest await the same result. Eviction never
  removes a lock that is currently held, so the guarantee survives capacity
  pressure.
- failure caching: a producer exception is cached for a few seconds and
  re-raised to waiters — during a DB outage the queued requests fail fast
  instead of re-running the expensive query one after another.
"""
import asyncio
import time
from typing import Any, Awaitable, Callable

_store: dict[str, tuple[float, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}
_MAX_KEYS = 512
_FAILURE_TTL = 5.0


class _Failure:
    __slots__ = ("exc",)

    def __init__(self, exc: BaseException):
        self.exc = exc


def _lookup(key: str):
    """-> (hit, value); raises the cached exception on a cached failure."""
    hit = _store.get(key)
    if hit and hit[0] > time.monotonic():
        if isinstance(hit[1], _Failure):
            raise hit[1].exc
        return True, hit[1]
    return False, None


def _evict() -> None:
    now = time.monotonic()
    if len(_store) >= _MAX_KEYS:
        for k in [k for k, (exp, _) in _store.items() if exp <= now]:
            _store.pop(k, None)
        while len(_store) >= _MAX_KEYS:
            oldest = min(_store, key=lambda k: _store[k][0])
            _store.pop(oldest, None)
    # prune idle locks (incl. ones whose producer failed and never stored) —
    # but NEVER a held lock: waiters queued on it rely on single-flight
    if len(_locks) > 2 * _MAX_KEYS:
        for k in list(_locks):
            if k not in _store and not _locks[k].locked():
                _locks.pop(k, None)


async def cached(key: str, ttl_seconds: float, producer: Callable[[], Awaitable[Any]]) -> Any:
    hit, value = _lookup(key)
    if hit:
        return value
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit, value = _lookup(key)  # re-check: another waiter may have filled it
        if hit:
            return value
        try:
            value = await producer()
        except Exception as exc:
            _store[key] = (time.monotonic() + _FAILURE_TTL, _Failure(exc))
            raise
        _evict()
        _store[key] = (time.monotonic() + ttl_seconds, value)
        return value
