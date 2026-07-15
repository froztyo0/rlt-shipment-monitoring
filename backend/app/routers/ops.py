"""Ops issue endpoints — the 'flag problems on their own' half of the app.

Everything here is set-based: lists of sales orders go into = ANY($1::text[])
queries so a page render costs a handful of queries, not N+1.
"""
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..cache import cached
from ..config import get_settings
from ..db import fetch_all
from ..analysis import quality as q
from ..analysis.milestones import infer_mode, load_mappings, validate_events
from ..geo import haversine_km, parse_coord, valid_lat_lon

router = APIRouter(prefix="/api/ops", tags=["ops"])

REJECT_TABLES = {
    "rome": ("etl.rome_inbound_rejects",
             "salesordernumber, orderid, orderstatus, ordertype, error_message, audit_timestamp"),
    "carrier": ("etl.carrier_inbound_rejects",
                'salesordernumber, carriername, "event", event_description, error_message, audit_timestamp'),
    "sensitech": ("etl.sensitech_inbound_rejects",
                  "salesordernumber, tripid, deviceserialnumber, error_message, audit_timestamp"),
}

# per-flag upstream existence probes: (name, table, key column, extra condition).
# Run set-based over the returned sales orders (one bounded query per probe),
# NOT as a correlated EXISTS per row — the latter seq-scanned big tables ~100x
# and timed out on real data. `in_3a2_sales` also matches salesordernumber_3a2.
TRACE_PROBES: dict[str, list[tuple[str, str, str, Optional[str]]]] = {
    "missing_batch": [
        ("in_batches_inbound", "etl.threeagesttwo_batches_inbound", "sales_order_id",
         "NULLIF(btrim(batch_no::text),'') IS NOT NULL"),
        ("in_batches_fullload", "etl.threeagesttwo_batches_inbound_fullload", "sales_order_id",
         "NULLIF(btrim(batch_no::text),'') IS NOT NULL"),
    ],
    "missing_carrier": [
        ("in_carrier_inbound", "etl.carrier_inbound", "salesordernumber", None),
        ("in_carrier_rejects", "etl.carrier_inbound_rejects", "salesordernumber", None),
    ],
    "no_sensitech_data": [
        ("in_sensitech_trip", "etl.sensitech_inbound_trip", "salesordernumber", None),
        ("in_sensitech_rejects", "etl.sensitech_inbound_rejects", "salesordernumber", None),
    ],
    "gps_stale": [
        ("in_sensitech_trip", "etl.sensitech_inbound_trip", "salesordernumber", None),
        ("in_sensitech_rejects", "etl.sensitech_inbound_rejects", "salesordernumber", None),
    ],
    "missing_planned_delivery": [
        ("in_rome_inbound", "etl.rome_inbound_orders", "salesordernumber", None),
        ("in_rome_rejects", "etl.rome_inbound_rejects", "salesordernumber", None),
    ],
    "upstream_silent_rome": [
        ("in_rome_inbound", "etl.rome_inbound_orders", "salesordernumber", None),
        ("in_rome_rejects", "etl.rome_inbound_rejects", "salesordernumber", None),
    ],
    "upstream_silent_3a2": [
        ("in_3a2_sales", "etl.threeagesttwo_sales_inbound", "sales_order_id", None),
    ],
    "upstream_silent_carrier": [
        ("in_carrier_inbound", "etl.carrier_inbound", "salesordernumber", None),
        ("in_carrier_rejects", "etl.carrier_inbound_rejects", "salesordernumber", None),
    ],
}


@router.get("/data-quality")
async def data_quality(flag: str, limit: int = Query(default=100, ge=1, le=300)):
    """Shipments hitting one flag, plus where the missing data actually lives."""
    if flag not in q.FLAG_DEFS:
        raise HTTPException(status_code=400, detail=f"Unknown flag '{flag}'")
    return await cached(f"ops:dq:{flag}:{limit}", 60, lambda: _compute_data_quality(flag, limit))


async def _compute_data_quality(flag: str, limit: int):
    s = get_settings()
    rows = await fetch_all(f"""
        SELECT s.trackingnumber, s.salesordernumber, s.salesordernumber_3a2, s.product,
               s.carrier, s.region, s.currentmilestone, s.injectiondate,
               s.planneddeliverydate, s.lastupdateddt, s.batchnumber
        FROM etl.shipment s
        WHERE {q.flag_sql(flag, s.gps_stale_hours)}
        ORDER BY s.lastupdateddt DESC NULLS LAST
        LIMIT {limit}
    """)
    probes = TRACE_PROBES.get(flag, [])
    ids = sorted({
        v for r in rows
        for v in (str(r.get("salesordernumber") or "").strip(),
                  str(r.get("salesordernumber_3a2") or "").strip())
        if v
    })
    # one bounded lookup per probe → the set of ids that exist in that source
    present: dict[str, set] = {}
    if ids:
        for name, table, key_col, cond in probes:
            where = f"{key_col}::text = ANY($1::text[])" + (f" AND {cond}" if cond else "")
            got = await fetch_all(
                f"SELECT DISTINCT {key_col}::text AS k FROM {table} WHERE {where}", ids)
            present[name] = {str(x["k"]).strip() for x in got if x["k"] is not None}

    cols = ["trackingnumber", "salesordernumber", "product", "carrier", "region",
            "currentmilestone", "injectiondate", "planneddeliverydate", "lastupdateddt", "batchnumber"]
    items = []
    for r in rows:
        so = str(r.get("salesordernumber") or "").strip()
        so3 = str(r.get("salesordernumber_3a2") or "").strip()
        upstream = {}
        for name, _t, _k, _c in probes:
            cand = {so, so3} if name == "in_3a2_sales" else {so}
            upstream[name] = bool((cand - {""}) & present.get(name, set()))
        items.append({**{k: r.get(k) for k in cols},
                      "upstream": upstream, "diagnosis": _diagnose(flag, upstream)})
    return {"flag": flag, "meta": q.FLAG_META[flag], "items": items}


def _diagnose(flag: str, up: dict) -> str:
    if not up:
        return "See shipment detail for source tracing"
    if flag == "missing_batch":
        if up.get("in_batches_inbound"):
            return "Batch exists upstream — ETL join failed to attach it"
        if up.get("in_batches_fullload"):
            return "Batch only in full-load snapshot — incremental (HVR) feed missed it"
        return "Never received from 3A GEST2"
    first_in = next((k for k, v in up.items() if v and "reject" not in k), None)
    rejected = next((k for k, v in up.items() if v and "reject" in k), None)
    if first_in:
        return f"Data exists upstream ({first_in.replace('in_', '')}) — pipeline didn't propagate it"
    if rejected:
        return f"Rows were REJECTED ({rejected.replace('in_', '')}) — check error_message"
    return "Never received from the source system"


@router.get("/rejects")
async def rejects(source: str = Query(pattern="^(rome|carrier|sensitech)$"),
                  hours: int = Query(default=168, ge=1, le=2160),
                  limit: int = Query(default=200, ge=1, le=500)):
    return await cached(f"ops:rejects:{source}:{hours}:{limit}", 60,
                        lambda: _compute_rejects(source, hours, limit))


async def _compute_rejects(source: str, hours: int, limit: int):
    table, cols = REJECT_TABLES[source]
    rows = await fetch_all(f"""
        SELECT {cols} FROM {table}
        WHERE audit_timestamp >= now() - make_interval(hours => {hours})
        ORDER BY audit_timestamp DESC
        LIMIT {limit}
    """)
    groups = await fetch_all(f"""
        SELECT COALESCE(NULLIF(btrim(error_message::text),''),'(no message)') AS error_message,
               COUNT(*) AS n
        FROM {table}
        WHERE audit_timestamp >= now() - make_interval(hours => {hours})
        GROUP BY 1 ORDER BY n DESC LIMIT 25
    """)
    return {"source": source, "hours": hours, "items": rows, "by_error": groups}


@router.get("/sequence-violations")
async def sequence_violations(window_days: int = Query(default=None, ge=1, le=60),
                              max_orders: int = Query(default=400, ge=10, le=1000)):
    """Replay recent shipments' carrier events against the milestone maps."""
    s = get_settings()
    window = window_days or s.active_window_days
    return await cached(f"ops:seq:{window}:{max_orders}", 120,
                        lambda: _compute_sequence_violations(window, max_orders))


async def _compute_sequence_violations(window: int, max_orders: int):
    ships = await fetch_all(f"""
        SELECT s.salesordernumber, s.trackingnumber, s.carrier, s.product, s.region,
               s.modeoftransportation, s.modeoftransportation_3a2, s.shipmenttype,
               s.transportmode_flight, s.flightnumber, s.currentmilestone
        FROM etl.shipment s
        WHERE ({q.ACTIVE_SQL} OR s.lastupdateddt::timestamp >= now() - make_interval(days => {window}))
          AND NULLIF(btrim(s.salesordernumber::text),'') IS NOT NULL
        ORDER BY s.lastupdateddt DESC NULLS LAST
        LIMIT {max_orders}
    """)
    if not ships:
        return {"checked_orders": 0, "orders_with_issues": 0, "violations": []}
    so_list = [str(sp["salesordernumber"]).strip() for sp in ships]
    by_so = {str(sp["salesordernumber"]).strip(): sp for sp in ships}

    events = await fetch_all(
        """SELECT salesordernumber, carriername, "event", event_description,
                  eventtimestamp, audit_timestamp
           FROM etl.carrier_inbound
           WHERE salesordernumber::text = ANY($1::text[])
           ORDER BY salesordernumber, eventtimestamp ASC NULLS LAST
           LIMIT 20000""",
        so_list,
    )
    grouped: dict[str, list[dict]] = {}
    for e in events:
        bucket = grouped.setdefault(str(e["salesordernumber"]).strip(), [])
        if len(bucket) < 500:  # a dirty SO with thousands of dupes can't starve the rest
            bucket.append(e)

    mappings = await load_mappings()
    out = []
    for so, evs in grouped.items():
        sp = by_so.get(so)
        mode = infer_mode(sp)
        res = validate_events(evs, (sp or {}).get("carrier"), mode, mappings)
        if res["issues"]:
            out.append({
                "salesordernumber": so,
                "trackingnumber": (sp or {}).get("trackingnumber"),
                "carrier": (sp or {}).get("carrier"),
                "product": (sp or {}).get("product"),
                "region": (sp or {}).get("region"),
                "mode": mode,
                "event_count": len(evs),
                "issues": res["issues"],
            })
    out.sort(key=lambda o: -len(o["issues"]))
    return {
        "checked_orders": len(ships),
        "orders_with_events": len(grouped),
        "orders_with_issues": len(out),
        "violations": out[:150],
    }


@router.get("/stale-injections")
async def stale_injections(limit: int = Query(default=200, ge=1, le=400)):
    """Injection date in the past, shipment not closed — classified RCA,
    computed set-based (5 queries total, not per-row)."""
    return await cached(f"ops:stale:{limit}", 120, lambda: _compute_stale_injections(limit))


async def _compute_stale_injections(limit: int):
    s = get_settings()
    ships = await fetch_all(f"""
        SELECT s.salesordernumber, s.trackingnumber, s.product, s.carrier, s.region,
               s.injectiondate, s.currentmilestone, s.dosestatus, s.lastgps,
               s.destinationlatitude, s.destinationlongitude, s.dist_threshold,
               s.actualdeparted, s.lastupdateddt
        FROM etl.shipment s
        WHERE {q.flag_sql('stale_injection', s.gps_stale_hours)}
        ORDER BY s.injectiondate::date DESC
        LIMIT {limit}
    """)
    if not ships:
        return {"total": 0, "items": [], "by_verdict": {}}
    so_list = [str(sp["salesordernumber"]).strip() for sp in ships if sp["salesordernumber"]]

    rome = await fetch_all(
        """SELECT DISTINCT ON (salesordernumber)
                  salesordernumber, orderstatus, orderstatuscategory, cancellationdate
           FROM etl.rome_inbound_orders
           WHERE salesordernumber::text = ANY($1::text[])
           ORDER BY salesordernumber, audit_timestamp DESC NULLS LAST""",
        so_list,
    )
    rome_by = {str(r["salesordernumber"]).strip(): r for r in rome}

    carrier = await fetch_all(
        """SELECT salesordernumber,
                  COUNT(*) AS n_events,
                  COUNT(*) FILTER (WHERE "event" ILIKE '%deliver%' OR "event" ILIKE '%completed%'
                                     OR NULLIF(btrim(actual_deliverytime::text),'') IS NOT NULL) AS n_delivered,
                  MAX(eventtimestamp) AS last_event
           FROM etl.carrier_inbound
           WHERE salesordernumber::text = ANY($1::text[])
           GROUP BY salesordernumber""",
        so_list,
    )
    carrier_by = {str(r["salesordernumber"]).strip(): r for r in carrier}

    last_ping = await fetch_all(
        """SELECT DISTINCT ON (salesordernumber)
                  salesordernumber, latitude, longitude, device_date_time
           FROM etl.sensitech_inbound_trip
           WHERE salesordernumber::text = ANY($1::text[])
             AND latitude IS NOT NULL AND longitude IS NOT NULL
             AND NOT (latitude::numeric = 0 AND longitude::numeric = 0)
           ORDER BY salesordernumber, device_date_time DESC NULLS LAST""",
        so_list,
    )
    ping_by = {str(r["salesordernumber"]).strip(): r for r in last_ping}

    items = []
    by_verdict: dict[str, int] = {}
    for sp in ships:
        so = str(sp["salesordernumber"] or "").strip()
        verdict, detail = _classify_stale(sp, rome_by.get(so), carrier_by.get(so),
                                          ping_by.get(so), s.default_geofence_km)
        by_verdict[verdict] = by_verdict.get(verdict, 0) + 1
        items.append({
            "salesordernumber": so,
            "trackingnumber": sp["trackingnumber"],
            "product": sp["product"],
            "carrier": sp["carrier"],
            "region": sp["region"],
            "injectiondate": sp["injectiondate"],
            "currentmilestone": sp["currentmilestone"],
            "dosestatus": sp["dosestatus"],
            "verdict": verdict,
            "detail": detail,
        })
    return {"total": len(items), "items": items, "by_verdict": by_verdict,
            "verdict_labels": VERDICT_LABELS}


VERDICT_LABELS = {
    "cancelled_upstream": "Cancelled in ROME, not closed here",
    "delivered_not_closed": "Carrier delivered, status never updated",
    "arrived_no_pod": "Reached destination geofence, no delivery confirmation",
    "gps_lost_in_transit": "GPS went silent mid-journey",
    "no_sensitech_data": "No Sensitech data ever received",
    "carrier_silent": "No carrier events at all",
    "never_departed": "Never departed origin",
    "unexplained": "Unexplained — investigate",
}


def _classify_stale(sp: dict, rome: Optional[dict], carrier: Optional[dict],
                    ping: Optional[dict], default_geofence_km: float) -> tuple[str, str]:
    if rome:
        status = f"{rome.get('orderstatus') or ''} {rome.get('orderstatuscategory') or ''}".lower()
        if rome.get("cancellationdate") or "cancel" in status:
            return "cancelled_upstream", f"ROME status: {status.strip()}, cancelled {rome.get('cancellationdate')}"
    if carrier and (carrier.get("n_delivered") or 0) > 0:
        return "delivered_not_closed", f"Carrier delivery event exists (last event {carrier.get('last_event')})"
    if ping:
        llat, llon = parse_coord(ping.get("latitude")), parse_coord(ping.get("longitude"))
        dlat, dlon = parse_coord(sp.get("destinationlatitude")), parse_coord(sp.get("destinationlongitude"))
        if valid_lat_lon(llat, llon) and valid_lat_lon(dlat, dlon):
            dist = haversine_km(llat, llon, dlat, dlon)
            thr = parse_coord(sp.get("dist_threshold")) or default_geofence_km
            if dist <= thr:
                return "arrived_no_pod", f"Last fix {round(dist, 2)} km from destination (≤ {thr} km geofence)"
        ts = ping.get("device_date_time")
        age_h = None
        if isinstance(ts, datetime):
            now = datetime.now(timezone.utc) if ts.tzinfo else datetime.now()
            age_h = (now - ts).total_seconds() / 3600.0
        if age_h is not None and age_h > 24:
            return "gps_lost_in_transit", f"Last ping {round(age_h)}h ago at {ping.get('latitude')},{ping.get('longitude')}"
    else:
        if not carrier or (carrier.get("n_events") or 0) == 0:
            return "carrier_silent", "No carrier events and no GPS pings — likely never shipped"
        return "no_sensitech_data", f"Carrier has {carrier.get('n_events')} events but device never pinged"
    if str(sp.get("actualdeparted") or "").strip() == "":
        return "never_departed", "No actual departure recorded"
    return "unexplained", "None of the standard causes matched — open the shipment for full RCA"


# ---------------------------------------------------------------------------
# injection-risk triage — the RLT deadline board
# ---------------------------------------------------------------------------
# RLT doses have a short half-life: the injection date/time is a hard deadline
# and the vial expires. This ranks active shipments by how likely they are to
# miss the injection (delivery ETA vs deadline) or arrive after vial expiry.
def _naive_dt(v) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.replace(tzinfo=None)
    s = str(v).strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        pass
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def _injection_deadline(date_v, time_v) -> Optional[datetime]:
    d = _naive_dt(date_v)
    if not d:
        return None
    if time_v:
        m = re.search(r"(\d{1,2}):(\d{2})\s*([AaPp][Mm])?", str(time_v))
        if m:
            h, mn, ap = int(m.group(1)), int(m.group(2)), (m.group(3) or "").upper()
            if ap == "PM" and h < 12:
                h += 12
            elif ap == "AM" and h == 12:
                h = 0
            if 0 <= h <= 23 and 0 <= mn <= 59:
                return d.replace(hour=h, minute=mn)
    return d.replace(hour=12)  # default midday when no injection time is given


_SEV_RANK = {"critical": 3, "serious": 2, "warning": 1, "info": 0}


@router.get("/injection-risk")
async def injection_risk(limit: int = Query(default=300, ge=1, le=600)):
    return await cached(f"ops:injrisk:{limit}", 60, lambda: _compute_injection_risk(limit))


async def _compute_injection_risk(limit: int):
    rows = await fetch_all(f"""
        SELECT s.salesordernumber, s.trackingnumber, s.product, s.carrier, s.region,
               s.injectiondate, s.injectiontime, s.etadeliverytime, s.planneddeliverydate,
               s.vialexpirationtime, s.currentmilestone, s.currentmilestonestep,
               s.dosestatus, s.risk, s.riskbucket, s.modeoftransportation,
               s.actualdeparted, s.lastgps, s.lastupdateddt
        FROM etl.shipment s
        WHERE {q.ACTIVE_SQL}
          AND s.injectiondate::text ~ '^\\s*\\d{{4}}-\\d{{2}}-\\d{{2}}'
          AND s.injectiondate::date BETWEEN CURRENT_DATE - 3 AND CURRENT_DATE + 21
        ORDER BY s.injectiondate::date ASC, s.lastupdateddt DESC NULLS LAST
        LIMIT {limit}
    """)

    now = datetime.now()
    risk_items, on_track = [], 0
    by_severity: dict[str, int] = {}
    for r in rows:
        deadline = _injection_deadline(r["injectiondate"], r["injectiontime"])
        eta = _naive_dt(r["etadeliverytime"])
        vial = _naive_dt(r["vialexpirationtime"])
        slack_h = round((deadline - eta).total_seconds() / 3600.0, 1) if (deadline and eta) else None

        if deadline is not None and deadline < now:
            sev, verdict = "critical", "Injection time passed — not delivered"
        elif eta is None:
            sev, verdict = "warning", "No ETA — delivery cannot be projected"
        elif vial is not None and eta > vial:
            sev, verdict = "critical", "Delivery ETA is after vial expiry"
        elif deadline is not None and eta > deadline:
            sev, verdict = "critical", "Delivery ETA is after the injection deadline"
        elif slack_h is not None and slack_h < 12:
            sev, verdict = "serious", f"Tight — only {slack_h:.0f}h before injection"
        elif slack_h is not None and slack_h < 24:
            sev, verdict = "warning", f"Watch — {slack_h:.0f}h before injection"
        else:
            sev, verdict = "info", "On track"

        if sev == "info":
            on_track += 1
            continue
        by_severity[sev] = by_severity.get(sev, 0) + 1
        risk_items.append({
            "salesordernumber": r["salesordernumber"],
            "trackingnumber": r["trackingnumber"],
            "product": r["product"],
            "carrier": r["carrier"],
            "region": r["region"],
            "modeoftransportation": r["modeoftransportation"],
            "currentmilestone": r["currentmilestone"],
            "injection_deadline": deadline.isoformat() if deadline else None,
            "eta": eta.isoformat() if eta else None,
            "vial_expiry": vial.isoformat() if vial else None,
            "slack_hours": slack_h,
            "severity": sev,
            "verdict": verdict,
        })

    risk_items.sort(key=lambda x: (-_SEV_RANK[x["severity"]],
                                   x["slack_hours"] if x["slack_hours"] is not None else 1e9))
    return {
        "checked": len(rows),
        "at_risk": len(risk_items),
        "on_track": on_track,
        "by_severity": by_severity,
        "items": risk_items,
    }
