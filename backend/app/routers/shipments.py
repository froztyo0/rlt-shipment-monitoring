"""Shipment list (the bottom table) — one query, inline flag booleans,
server-side filters + pagination, and a distinct-values endpoint for the
filter dropdowns."""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Query

from ..cache import cached
from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..analysis import quality as q

router = APIRouter(prefix="/api/shipments", tags=["shipments"])

LIST_COLUMNS = """
  s.trackingnumber, s.salesordernumber, s.product, s.destinationname,
  s.destinationcity, s.destinationcountry, s.injectiondate, s.injectiontime,
  s.ordertype, s.dosestatus, s.origin, s.batchnumber, s.planneddeliverydate,
  s.planneddeliverytime, s.carrier, s.modeoftransportation, s.region,
  s.currentmilestone, s.currentmilestonestep, s.routestatus, s.risk,
  s.riskbucket, s.risk_reason, s.countofalerts, s.alertstitle, s.alerttype,
  s.lastgps, s.lastupdateddt, s.etadeliverytime, s.flightnumber,
  s.carriertrackingnumber, s.actualdeparted, s.actualdeliverytime,
  s.delayreason, s.currentleg, s.totallegs, s.shipmenttype, s.production_site
"""

SORTABLE = {
    "injectiondate": "s.injectiondate",
    "planneddeliverydate": "s.planneddeliverydate",
    "lastupdateddt": "s.lastupdateddt",
    "carrier": "s.carrier",
    "salesordernumber": "s.salesordernumber",
    "risk": "s.risk",
}


def _build_where(
    search: Optional[str], carrier: Optional[str], region: Optional[str],
    ordertype: Optional[str], milestone: Optional[str], product: Optional[str],
    status: Optional[str], risk: Optional[str], flag: Optional[str],
    only_issues: bool, gps_h: int, args: list,
    injection_from: Optional[date] = None, injection_to: Optional[date] = None,
) -> str:
    conds = ["TRUE"]

    def bind(v) -> str:
        args.append(v)
        return f"${len(args)}"

    if search:
        p = bind(f"%{search.strip()}%")
        conds.append(
            f"(s.salesordernumber::text ILIKE {p} OR s.trackingnumber::text ILIKE {p} "
            f"OR s.carriertrackingnumber::text ILIKE {p} OR s.destinationname::text ILIKE {p} "
            f"OR s.batchnumber::text ILIKE {p})"
        )
    if carrier:
        conds.append(f"s.carrier = {bind(carrier)}")
    if region:
        conds.append(f"s.region = {bind(region)}")
    if ordertype:
        conds.append(f"s.ordertype = {bind(ordertype)}")
    if milestone:
        conds.append(f"s.currentmilestone = {bind(milestone)}")
    if product:
        conds.append(f"s.product = {bind(product)}")
    if risk:
        conds.append(f"(s.risk = {bind(risk)} OR s.riskbucket = {bind(risk)})")
    if status == "active":
        conds.append(q.ACTIVE_SQL)
    elif status == "delivered":
        conds.append(q.DELIVERED_SQL)
    elif status == "cancelled":
        conds.append(q.CANCELLED_SQL)
    elif status == "in_transit":
        conds.append(f"({q.ACTIVE_SQL} AND NULLIF(btrim(s.actualdeparted::text),'') IS NOT NULL)")
    if flag and flag in q.FLAG_DEFS:
        conds.append(q.flag_sql(flag, gps_h))
    if only_issues:
        conds.append(q.any_flag_sql(gps_h))
    # injection window: blank injection dates stay visible — they're the
    # data-quality rows the dashboard exists to surface
    if injection_from:
        conds.append(
            f"(NULLIF(btrim(s.injectiondate::text),'') IS NULL OR s.injectiondate::date >= {bind(injection_from)})"
        )
    if injection_to:
        conds.append(
            f"(NULLIF(btrim(s.injectiondate::text),'') IS NULL OR s.injectiondate::date <= {bind(injection_to)})"
        )
    return " AND ".join(conds)


@router.get("")
async def list_shipments(
    search: Optional[str] = None,
    carrier: Optional[str] = None,
    region: Optional[str] = None,
    ordertype: Optional[str] = None,
    milestone: Optional[str] = None,
    product: Optional[str] = None,
    status: Optional[str] = Query(default=None, pattern="^(active|delivered|cancelled|in_transit)$"),
    risk: Optional[str] = None,
    flag: Optional[str] = None,
    only_issues: bool = False,
    injection_from: Optional[date] = None,
    injection_to: Optional[date] = None,
    sort: str = Query(default="lastupdateddt"),
    dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    s = get_settings()
    gps_h = s.gps_stale_hours
    args: list = []
    where = _build_where(search, carrier, region, ordertype, milestone, product,
                         status, risk, flag, only_issues, gps_h, args,
                         injection_from, injection_to)
    order_col = SORTABLE.get(sort, "s.lastupdateddt")
    order = f"{order_col} {'ASC' if dir == 'asc' else 'DESC'} NULLS LAST"

    total = await fetch_one(f"SELECT COUNT(*) AS n FROM etl.shipment s WHERE {where}", *args)
    offset = (page - 1) * page_size
    rows = await fetch_all(
        f"""SELECT {LIST_COLUMNS}, {q.flag_select_columns(gps_h)}
            FROM etl.shipment s
            WHERE {where}
            ORDER BY {order}
            LIMIT {page_size} OFFSET {offset}""",
        *args,
    )
    items = []
    for r in rows:
        issues = q.extract_flags(r)
        item = {k: v for k, v in r.items() if not k.startswith("flag_")}
        item["issues"] = issues
        item["issue_count"] = len(issues)
        item["max_severity"] = _max_severity(issues)
        items.append(item)
    return {
        "total": total["n"] if total else 0,
        "page": page,
        "page_size": page_size,
        "items": items,
    }


_SEV_ORDER = {"critical": 3, "serious": 2, "warning": 1, "info": 0}


def _max_severity(issues: list[dict]) -> Optional[str]:
    if not issues:
        return None
    return max(issues, key=lambda i: _SEV_ORDER.get(i["severity"], 0))["severity"]


@router.get("/filters")
async def filter_values():
    """Distinct values for the dropdowns — cached, changes rarely."""
    return await cached("shipments:filters", 300, _compute_filter_values)


async def _compute_filter_values():
    out = {}
    for key, col in (("carriers", "carrier"), ("regions", "region"),
                     ("ordertypes", "ordertype"), ("products", "product"),
                     ("milestones", "currentmilestone"), ("risks", "riskbucket")):
        rows = await fetch_all(
            f"""SELECT {col} AS v, COUNT(*) AS n FROM etl.shipment s
                WHERE NULLIF(btrim({col}::text), '') IS NOT NULL
                GROUP BY {col} ORDER BY n DESC LIMIT 50"""
        )
        out[key] = [r["v"] for r in rows]
    out["flags"] = [
        {"code": name, **meta} for name, meta in q.FLAG_META.items()
    ]
    return out
