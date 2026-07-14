"""KPI aggregates. One pass over etl.shipment for the headline numbers and
flag counts, plus three tiny reject-table counts."""
from fastapi import APIRouter, Query

from ..cache import cached
from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..analysis import quality as q

router = APIRouter(prefix="/api/kpis", tags=["kpis"])

KPI_TTL = 60  # seconds — dashboard polling never costs more than 1 burst/min


@router.get("")
async def kpis(window_days: int = Query(default=None, ge=1, le=90)):
    s = get_settings()
    window = window_days or s.active_window_days
    return await cached(f"kpis:{window}", KPI_TTL, lambda: _compute_kpis(window))


async def _compute_kpis(window: int):
    s = get_settings()
    gps_h = s.gps_stale_hours

    # "in scope" = still open, or closed within the window (so Delivered-today
    # style KPIs have data but ancient history doesn't skew counts)
    scope = (
        f"({q.ACTIVE_SQL} OR s.lastupdateddt::timestamp >= now() - make_interval(days => {window}))"
    )

    core = await fetch_one(f"""
        SELECT
          COUNT(*)                                                        AS in_scope,
          COUNT(*) FILTER (WHERE {q.ACTIVE_SQL})                          AS active,
          COUNT(*) FILTER (WHERE {q.ACTIVE_SQL}
                             AND NULLIF(btrim(s.actualdeparted::text),'') IS NOT NULL) AS in_transit,
          COUNT(*) FILTER (WHERE {q.DELIVERED_SQL}
                             AND s.lastupdateddt::timestamp >= CURRENT_DATE)           AS delivered_today,
          COUNT(*) FILTER (WHERE {q.CANCELLED_SQL})                       AS cancelled,
          COUNT(*) FILTER (WHERE {q.ACTIVE_SQL} AND (
                s.risk ILIKE '%high%' OR s.risk ILIKE '%critical%' OR s.riskbucket ILIKE '%high%'
                OR s.riskbucket ILIKE '%critical%' OR s.risk ILIKE '%at risk%'))       AS at_risk,
          COUNT(*) FILTER (WHERE {q.ACTIVE_SQL}
                             AND COALESCE(NULLIF(btrim(s.countofalerts::text),''),'0')::numeric > 0) AS with_alerts,
          COUNT(*) FILTER (WHERE {q.any_flag_sql(gps_h)} AND {q.ACTIVE_SQL})           AS with_issues,
          {q.flag_count_columns(gps_h)}
        FROM etl.shipment s
        WHERE {scope}
    """)

    rejects = {}
    for key, table in (("rome", "etl.rome_inbound_rejects"),
                       ("carrier", "etl.carrier_inbound_rejects"),
                       ("sensitech", "etl.sensitech_inbound_rejects")):
        row = await fetch_one(f"""
            SELECT COUNT(*) FILTER (WHERE audit_timestamp >= now() - interval '24 hours') AS last_24h,
                   COUNT(*) FILTER (WHERE audit_timestamp >= now() - make_interval(days => {window})) AS window
            FROM {table}
        """)
        rejects[key] = row or {"last_24h": 0, "window": 0}

    flags = {
        name: {"count": core.pop(f"n_{name}", 0) or 0, **meta}
        for name, meta in q.FLAG_META.items()
    }

    return {
        "window_days": window,
        "core": core,
        "flags": flags,
        "rejects": rejects,
    }


@router.get("/alerts")
async def alert_breakdown(window_days: int = Query(default=None, ge=1, le=90)):
    """Counts per alert title across active shipments (alertstitle can hold a
    comma-separated list)."""
    s = get_settings()
    window = window_days or s.active_window_days
    return await cached(f"kpis:alerts:{window}", KPI_TTL, lambda: _compute_alerts(window))


async def _compute_alerts(window: int):
    rows = await fetch_all(f"""
        SELECT btrim(t.title) AS title, COUNT(*) AS n
        FROM etl.shipment s,
             LATERAL regexp_split_to_table(COALESCE(s.alertstitle::text, ''), '\\s*[,;|]\\s*') AS t(title)
        WHERE ({q.ACTIVE_SQL} OR s.lastupdateddt::timestamp >= now() - make_interval(days => {window}))
          AND NULLIF(btrim(t.title), '') IS NOT NULL
        GROUP BY btrim(t.title)
        ORDER BY n DESC
        LIMIT 40
    """)
    return {"alerts": rows}
