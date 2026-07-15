"""Analytics aggregates over etl.shipment — carrier performance, delivery
status distribution, mode/region/product volume, top lanes, weekly on-time
trend. All single-pass GROUP BYs over the shipment table, windowed by
injection date and cached, so the analytics page costs a handful of queries
per TTL regardless of viewers."""
from fastapi import APIRouter, Query

from ..cache import cached
from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..analysis import quality as q

router = APIRouter(prefix="/api/analytics", tags=["analytics"])
TTL = 120

# regex guards so a single non-ISO text value can't error a whole aggregate
INJ_OK = r"(s.injectiondate ~ '^\s*\d{4}-\d{2}-\d{2}')"
PLANNED_OK = r"(s.planneddeliverydate ~ '^\s*\d{4}-\d{2}-\d{2}')"
DELIV_TS = r"(CASE WHEN s.actualdeliverytime ~ '^\s*\d{4}-\d{2}-\d{2}' THEN s.actualdeliverytime::timestamp END)"
DEP_TS = r"(CASE WHEN s.actualdeparted ~ '^\s*\d{4}-\d{2}-\d{2}' THEN s.actualdeparted::timestamp END)"

ARRIVED = "COALESCE(s.routestatus ILIKE '%arriv%', FALSE)"
DEPARTED = "(NULLIF(btrim(s.actualdeparted::text),'') IS NOT NULL)"
AT_RISK = ("COALESCE(s.risk ILIKE '%high%' OR s.risk ILIKE '%critical%' "
           "OR s.riskbucket ILIKE '%high%' OR s.riskbucket ILIKE '%critical%', FALSE)")

DELIVERED = f"({q.DELIVERED_SQL} AND NOT {q.CANCELLED_SQL})"
ARRIVED_X = f"({ARRIVED} AND NOT {q.DELIVERED_SQL} AND NOT {q.CANCELLED_SQL})"
IN_TRANSIT = f"({DEPARTED} AND NOT {ARRIVED} AND NOT {q.DELIVERED_SQL} AND NOT {q.CANCELLED_SQL})"
NOT_STARTED = f"(NOT {DEPARTED} AND NOT {ARRIVED} AND NOT {q.DELIVERED_SQL} AND NOT {q.CANCELLED_SQL})"
ON_TIME = f"({DELIVERED} AND {DELIV_TS} IS NOT NULL AND {PLANNED_OK} AND {DELIV_TS}::date <= s.planneddeliverydate::date)"
LATE = f"({DELIVERED} AND {DELIV_TS} IS NOT NULL AND {PLANNED_OK} AND {DELIV_TS}::date > s.planneddeliverydate::date)"
TRANSIT_AVG = (f"AVG(EXTRACT(EPOCH FROM ({DELIV_TS} - {DEP_TS}))/3600.0) "
               f"FILTER (WHERE {DELIVERED} AND {DELIV_TS} IS NOT NULL AND {DEP_TS} IS NOT NULL "
               f"AND {DELIV_TS} > {DEP_TS})")


def _scope(window: int) -> str:
    return (f"({INJ_OK} AND s.injectiondate::date "
            f"BETWEEN CURRENT_DATE - make_interval(days => {int(window)}) AND CURRENT_DATE)")


def _pct(num, den):
    return round(100.0 * num / den, 1) if den else None


@router.get("/carriers")
async def carrier_performance(window_days: int = Query(default=30, ge=1, le=180)):
    return await cached(f"an:carriers:{window_days}", TTL, lambda: _carriers(window_days))


async def _carriers(window: int):
    s = get_settings()
    scope = _scope(window)
    rows = await fetch_all(f"""
        SELECT
          COALESCE(NULLIF(TRIM(s.carrier::text), ''), '(unassigned)') AS carrier,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE {DELIVERED}) AS delivered,
          COUNT(*) FILTER (WHERE {q.CANCELLED_SQL}) AS cancelled,
          COUNT(*) FILTER (WHERE {ARRIVED_X} OR {IN_TRANSIT}) AS active,
          COUNT(*) FILTER (WHERE {ON_TIME}) AS on_time,
          COUNT(*) FILTER (WHERE {LATE}) AS late,
          COUNT(*) FILTER (WHERE {AT_RISK} AND NOT {q.TERMINAL_SQL}) AS at_risk,
          COUNT(*) FILTER (WHERE {q.any_flag_sql(s.gps_stale_hours)}) AS with_issues,
          {TRANSIT_AVG} AS avg_transit_hours
        FROM etl.shipment s
        WHERE {scope}
        GROUP BY 1
        ORDER BY total DESC
        LIMIT 40
    """)
    out = []
    for r in rows:
        deliv, late = int(r["delivered"] or 0), int(r["late"] or 0)
        on_time = int(r["on_time"] or 0)
        out.append({
            "carrier": r["carrier"],
            "total": int(r["total"] or 0),
            "delivered": deliv,
            "cancelled": int(r["cancelled"] or 0),
            "active": int(r["active"] or 0),
            "on_time": on_time,
            "late": late,
            "on_time_pct": _pct(on_time, on_time + late),
            "cancel_pct": _pct(int(r["cancelled"] or 0), int(r["total"] or 0)),
            "issue_pct": _pct(int(r["with_issues"] or 0), int(r["total"] or 0)),
            "at_risk": int(r["at_risk"] or 0),
            "avg_transit_hours": round(float(r["avg_transit_hours"]), 1) if r["avg_transit_hours"] is not None else None,
        })
    return {"window_days": window, "carriers": out}


@router.get("/overview")
async def overview(window_days: int = Query(default=30, ge=1, le=180)):
    return await cached(f"an:overview:{window_days}", TTL, lambda: _overview(window_days))


async def _overview(window: int):
    scope = _scope(window)
    core = await fetch_one(f"""
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE {DELIVERED}) AS delivered,
          COUNT(*) FILTER (WHERE {ARRIVED_X}) AS arrived,
          COUNT(*) FILTER (WHERE {IN_TRANSIT}) AS in_transit,
          COUNT(*) FILTER (WHERE {NOT_STARTED}) AS not_started,
          COUNT(*) FILTER (WHERE {q.CANCELLED_SQL}) AS cancelled,
          COUNT(*) FILTER (WHERE {ON_TIME}) AS on_time,
          COUNT(*) FILTER (WHERE {LATE}) AS late,
          COUNT(*) FILTER (WHERE {q.IS_AIR_SQL}) AS air,
          COUNT(*) FILTER (WHERE NOT {q.IS_AIR_SQL}) AS road,
          COUNT(*) FILTER (WHERE {AT_RISK} AND NOT {q.TERMINAL_SQL}) AS at_risk,
          {TRANSIT_AVG} AS avg_transit_hours
        FROM etl.shipment s
        WHERE {scope}
    """)

    async def by(col: str, limit: int = 8):
        return await fetch_all(f"""
            SELECT COALESCE(NULLIF(TRIM(s.{col}::text), ''), '(none)') AS label, COUNT(*) AS n
            FROM etl.shipment s WHERE {scope}
            GROUP BY 1 ORDER BY n DESC LIMIT {limit}
        """)

    by_region = await by("region")
    by_product = await by("product")

    lanes = await fetch_all(f"""
        SELECT COALESCE(NULLIF(TRIM(s.origin::text), ''), '?')
               || '  →  ' || COALESCE(NULLIF(TRIM(s.destinationname::text), ''), '?') AS label,
               COUNT(*) AS n
        FROM etl.shipment s WHERE {scope}
        GROUP BY 1 ORDER BY n DESC LIMIT 10
    """)

    weekly = await fetch_all(f"""
        SELECT to_char(date_trunc('week', s.injectiondate::date), 'YYYY-MM-DD') AS week,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE {DELIVERED}) AS delivered,
               COUNT(*) FILTER (WHERE {ON_TIME}) AS on_time,
               COUNT(*) FILTER (WHERE {LATE}) AS late
        FROM etl.shipment s WHERE {scope}
        GROUP BY 1 ORDER BY 1
    """)

    avg_t = core["avg_transit_hours"]
    return {
        "window_days": window,
        "totals": {
            "total": int(core["total"] or 0),
            "delivered": int(core["delivered"] or 0),
            "arrived": int(core["arrived"] or 0),
            "in_transit": int(core["in_transit"] or 0),
            "not_started": int(core["not_started"] or 0),
            "cancelled": int(core["cancelled"] or 0),
            "on_time": int(core["on_time"] or 0),
            "late": int(core["late"] or 0),
            "on_time_pct": _pct(int(core["on_time"] or 0), int(core["on_time"] or 0) + int(core["late"] or 0)),
            "air": int(core["air"] or 0),
            "road": int(core["road"] or 0),
            "at_risk": int(core["at_risk"] or 0),
            "avg_transit_hours": round(float(avg_t), 1) if avg_t is not None else None,
        },
        "by_region": [{"label": r["label"], "value": int(r["n"])} for r in by_region],
        "by_product": [{"label": r["label"], "value": int(r["n"])} for r in by_product],
        "top_lanes": [{"label": r["label"], "value": int(r["n"])} for r in lanes],
        "weekly": [{
            "week": r["week"], "total": int(r["total"]),
            "delivered": int(r["delivered"]), "on_time": int(r["on_time"]), "late": int(r["late"]),
        } for r in weekly],
    }
