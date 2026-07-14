"""Read-only asyncpg pool.

Every connection is opened with default_transaction_read_only=on so no
statement issued through this pool can write, regardless of SQL text.
A statement timeout keeps runaway queries from hurting the RDS instance.
"""
import asyncio
import ssl
from typing import Any, Optional

import asyncpg

from .config import get_settings

_pool: Optional[asyncpg.Pool] = None
_pool_lock = asyncio.Lock()


def _ssl_context(mode: str):
    mode = (mode or "prefer").lower()
    if mode == "disable":
        return None
    ctx = ssl.create_default_context()
    # RDS certs frequently aren't in the local trust store; we still encrypt.
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    async with _pool_lock:  # cold start races would otherwise leak pools
        if _pool is not None:
            return _pool
        s = get_settings()
        _pool = await asyncpg.create_pool(
            host=s.db_host,
            port=s.db_port,
            database=s.db_name,
            user=s.db_user,
            password=s.db_password,
            ssl=_ssl_context(s.db_sslmode),
            min_size=s.db_pool_min,
            max_size=s.db_pool_max,
            command_timeout=max(5, s.db_statement_timeout_ms / 1000),
            server_settings={
                "default_transaction_read_only": "on",
                "statement_timeout": str(s.db_statement_timeout_ms),
                "application_name": "rlt-shipment-monitoring",
            },
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def fetch_all(sql: str, *args: Any) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return [dict(r) for r in rows]


async def fetch_one(sql: str, *args: Any) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, *args)
    return dict(row) if row else None


async def fetch_val(sql: str, *args: Any) -> Any:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(sql, *args)
