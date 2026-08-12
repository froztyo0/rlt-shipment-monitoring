"""Analytics aggregates over etl.shipment — carrier performance, delivery
status distribution, mode/region/product volume, top lanes, weekly on-time
trend. All single-pass GROUP BYs over the shipment table, windowed by
injection date and cached, so the analytics page costs a handful of queries
per TTL regardless of viewers."""
import statistics
from datetime import datetime

from fastapi import APIRouter, Query

from ..cache import cached
from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..analysis import quality as q
from ..analysis.milestones import infer_mode, load_mappings

router = APIRouter(prefix="/api/analytics", tags=["analytics"])
TTL = 120

# regex guards so a single non-ISO text value can't error a whole aggregate.
# cast ::text first — on real RDS these columns are date/timestamp types and
# the ~ operator only exists for text.
INJ_OK = r"(s.injectiondate::text ~ '^\s*\d{4}-\d{2}-\d{2}')"
PLANNED_OK = r"(s.planneddeliverydate::text ~ '^\s*\d{4}-\d{2}-\d{2}')"
DELIV_TS = r"(CASE WHEN s.actualdeliverytime::text ~ '^\s*\d{4}-\d{2}-\d{2}' THEN s.actualdeliverytime::timestamp END)"
DEP_TS = r"(CASE WHEN s.actualdeparted::text ~ '^\s*\d{4}-\d{2}-\d{2}' THEN s.actualdeparted::timestamp END)"

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


# ---------------------------------------------------------------------------
# matrices — carrier×region reliability, region×status, injection calendar
# ---------------------------------------------------------------------------
@router.get("/matrix")
async def matrix(window_days: int = Query(default=30, ge=1, le=180)):
    return await cached(f"an:matrix:{window_days}", TTL, lambda: _matrix(window_days))


async def _matrix(window: int):
    scope = _scope(window)

    cr = await fetch_all(f"""
        SELECT COALESCE(NULLIF(TRIM(s.carrier::text), ''), '(unassigned)') AS carrier,
               COALESCE(NULLIF(TRIM(s.region::text), ''), '(none)') AS region,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE {DELIVERED}) AS delivered,
               COUNT(*) FILTER (WHERE {ON_TIME}) AS on_time,
               COUNT(*) FILTER (WHERE {LATE}) AS late
        FROM etl.shipment s WHERE {scope}
        GROUP BY 1, 2
    """)
    carrier_tot: dict[str, int] = {}
    region_tot: dict[str, int] = {}
    cr_cells = []
    for r in cr:
        c, reg = r["carrier"], r["region"]
        ot, la = int(r["on_time"] or 0), int(r["late"] or 0)
        carrier_tot[c] = carrier_tot.get(c, 0) + int(r["total"] or 0)
        region_tot[reg] = region_tot.get(reg, 0) + int(r["total"] or 0)
        cr_cells.append({
            "carrier": c, "region": reg,
            "on_time_pct": _pct(ot, ot + la), "delivered": int(r["delivered"] or 0),
            "total": int(r["total"] or 0),
        })
    carriers = [c for c, _ in sorted(carrier_tot.items(), key=lambda kv: -kv[1])][:12]
    regions = [r for r, _ in sorted(region_tot.items(), key=lambda kv: -kv[1])][:12]
    cr_set = set(carriers)
    rg_set = set(regions)
    cr_cells = [c for c in cr_cells if c["carrier"] in cr_set and c["region"] in rg_set]

    rs = await fetch_all(f"""
        SELECT COALESCE(NULLIF(TRIM(s.region::text), ''), '(none)') AS region,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE {DELIVERED}) AS delivered,
               COUNT(*) FILTER (WHERE {IN_TRANSIT}) AS in_transit,
               COUNT(*) FILTER (WHERE {ARRIVED_X}) AS arrived,
               COUNT(*) FILTER (WHERE {NOT_STARTED}) AS not_started,
               COUNT(*) FILTER (WHERE {q.CANCELLED_SQL}) AS cancelled
        FROM etl.shipment s WHERE {scope}
        GROUP BY 1 ORDER BY total DESC LIMIT 12
    """)
    region_status = [{
        "region": r["region"], "total": int(r["total"] or 0),
        "delivered": int(r["delivered"] or 0), "in_transit": int(r["in_transit"] or 0),
        "arrived": int(r["arrived"] or 0), "not_started": int(r["not_started"] or 0),
        "cancelled": int(r["cancelled"] or 0),
    } for r in rs]

    # calendar spans the window back + 30 days forward, so upcoming crunch days show
    cal = await fetch_all(f"""
        SELECT s.injectiondate::date AS day, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE {AT_RISK} AND NOT {q.TERMINAL_SQL}) AS at_risk,
               COUNT(*) FILTER (WHERE s.injectiondate::date < CURRENT_DATE AND NOT {q.TERMINAL_SQL}) AS overdue
        FROM etl.shipment s
        WHERE {INJ_OK} AND s.injectiondate::date
              BETWEEN CURRENT_DATE - make_interval(days => {int(window)}) AND CURRENT_DATE + 30
        GROUP BY 1 ORDER BY 1
    """)
    calendar = [{
        "day": str(r["day"]), "total": int(r["total"] or 0),
        "at_risk": int(r["at_risk"] or 0), "overdue": int(r["overdue"] or 0),
    } for r in cal]

    return {
        "window_days": window,
        "carriers": carriers, "regions": regions,
        "carrier_region": cr_cells,
        "statuses": ["delivered", "in_transit", "arrived", "not_started", "cancelled"],
        "region_status": region_status,
        "calendar": calendar,
    }


# ---------------------------------------------------------------------------
# milestone dwell-time — where time is lost between stages
# ---------------------------------------------------------------------------
def _to_dt(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


@router.get("/dwell")
async def dwell(window_days: int = Query(default=30, ge=1, le=180),
                max_orders: int = Query(default=600, ge=50, le=1200)):
    return await cached(f"an:dwell:{window_days}:{max_orders}", 300,
                        lambda: _dwell(window_days, max_orders))


async def _dwell(window: int, max_orders: int):
    scope = _scope(window)
    ships = await fetch_all(f"""
        SELECT s.salesordernumber, s.carrier, s.modeoftransportation,
               s.modeoftransportation_3a2, s.shipmenttype, s.transportmode_flight, s.flightnumber
        FROM etl.shipment s
        WHERE {scope} AND NULLIF(btrim(s.salesordernumber::text), '') IS NOT NULL
        ORDER BY s.lastupdateddt DESC NULLS LAST
        LIMIT {max_orders}
    """)
    if not ships:
        return {"window_days": window, "transitions": [], "carriers": [], "orders": 0}

    by_so = {str(sp["salesordernumber"]).strip(): sp for sp in ships}
    so_list = list(by_so.keys())
    events = await fetch_all(
        """SELECT salesordernumber, carriername, "event", eventtimestamp
           FROM etl.carrier_inbound
           WHERE salesordernumber::text = ANY($1::text[]) AND eventtimestamp IS NOT NULL
           ORDER BY salesordernumber, eventtimestamp ASC
           LIMIT 40000""",
        so_list,
    )
    grouped: dict[str, list] = {}
    for e in events:
        b = grouped.setdefault(str(e["salesordernumber"]).strip(), [])
        if len(b) < 400:
            b.append(e)

    mappings = await load_mappings()
    step_of: dict[str, int] = {}
    transitions: dict[tuple, list] = {}
    carrier_span: dict[str, list] = {}
    orders_used = 0

    for so, evs in grouped.items():
        sp = by_so.get(so)
        mode = infer_mode(sp)
        carrier_disp = (str((sp or {}).get("carrier") or "").strip()
                        or str(evs[0].get("carriername") or "").strip() or "(unknown)").upper()
        cmap_mode = mappings.get(mode, {})
        stage_ts: dict[str, tuple] = {}  # ui_milestone -> (step, earliest ts)
        for e in evs:
            cn = str(e.get("carriername") or (sp or {}).get("carrier") or "").strip().upper()
            ev = str(e.get("event") or "").strip().lower()
            info = cmap_mode.get(cn, {}).get(ev)
            if not info:
                continue
            step, flag, ui = info.get("step"), info.get("flag"), info.get("ui_milestone")
            if step is None or ui is None or (flag or 0) <= 0:
                continue
            ts = _to_dt(e.get("eventtimestamp"))
            if not ts:
                continue
            step_of.setdefault(ui, step)
            cur = stage_ts.get(ui)
            if cur is None or ts < cur[1]:
                stage_ts[ui] = (step, ts)

        if len(stage_ts) < 2:
            continue
        orders_used += 1
        ordered = sorted(stage_ts.items(), key=lambda kv: kv[1][0])
        for (ua, (_sa, ta)), (ub, (_sb, tb)) in zip(ordered, ordered[1:]):
            if tb <= ta:
                continue
            h = (tb - ta).total_seconds() / 3600.0
            if h > 24 * 45:  # guard against absurd gaps from dirty timestamps
                continue
            transitions.setdefault((ua, ub), []).append(h)
        span_h = (ordered[-1][1][1] - ordered[0][1][1]).total_seconds() / 3600.0
        if 0 < span_h <= 24 * 45:
            carrier_span.setdefault(carrier_disp, []).append(span_h)

    out = []
    for (a, b), vals in transitions.items():
        out.append({
            "from": a, "to": b, "label": f"{a} → {b}", "n": len(vals),
            "avg_hours": round(statistics.mean(vals), 1),
            "median_hours": round(statistics.median(vals), 1),
            "max_hours": round(max(vals), 1),
        })
    out.sort(key=lambda t: step_of.get(t["from"], 99))

    carriers = [{
        "carrier": c, "orders": len(v),
        "avg_span_hours": round(statistics.mean(v), 1),
        "median_span_hours": round(statistics.median(v), 1),
    } for c, v in carrier_span.items()]
    carriers.sort(key=lambda c: -c["avg_span_hours"])

    return {"window_days": window, "orders": orders_used, "transitions": out, "carriers": carriers}
