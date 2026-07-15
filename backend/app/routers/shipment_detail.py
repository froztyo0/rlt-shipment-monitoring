"""Single-shipment endpoints: detail + RCA, pings/map analysis, milestones.

One Sensitech tracking number can carry SEVERAL sales orders (multi-dose
trips). Lookups therefore resolve to a *group*: a primary row (the requested
SO, or the most recently updated) plus sibling orders on the same tracking
number. GPS pings are merged across the group (the device belongs to the
trip, and upstream duplicates the rows per SO), while milestones stay per-SO
— each order has its own carrier booking to validate.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from .. import airports
from ..config import get_settings
from ..db import fetch_all
from ..analysis import quality as q
from ..analysis.ghost import analyze_pings
from ..analysis.milestones import infer_mode, load_mappings, validate_events
from ..analysis.rca import stale_injection_rca, trace_missing_fields
from ..geo import parse_coord, valid_lat_lon

router = APIRouter(prefix="/api/shipments", tags=["shipment-detail"])


async def _get_group(tracking: str, so: Optional[str] = None) -> tuple[dict, list[dict]]:
    """Resolve tracking number OR sales order -> (primary row, all rows in
    the tracking group). Two small indexed queries at most."""
    s = get_settings()
    cols = f"s.*, {q.flag_select_columns(s.gps_stale_hours)}"
    rows = await fetch_all(
        f"""SELECT {cols} FROM etl.shipment s
            WHERE s.trackingnumber::text = $1 OR s.salesordernumber::text = $1
            ORDER BY s.lastupdateddt DESC NULLS LAST
            LIMIT 20""",
        tracking,
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"No shipment for '{tracking}'")

    # entry by SO returns one row — widen to every SO on its tracking number.
    # entry by tracking number already matched the whole group in query 1.
    tn = str(rows[0].get("trackingnumber") or "").strip()
    if tn and tn != tracking.strip():
        group = await fetch_all(
            f"""SELECT {cols} FROM etl.shipment s
                WHERE s.trackingnumber::text = $1
                ORDER BY s.lastupdateddt DESC NULLS LAST
                LIMIT 20""",
            tn,
        )
        if group:
            rows = group

    # primary = explicit ?so= > the SO the user navigated by > most recent
    want = (so or "").strip() or tracking.strip()
    primary = next(
        (r for r in rows if str(r.get("salesordernumber") or "").strip() == want),
        rows[0],
    )
    return primary, rows


def _order_summary(r: dict) -> dict:
    issues = q.extract_flags(r)
    return {
        "salesordernumber": r.get("salesordernumber"),
        "product": r.get("product"),
        "batchnumber": r.get("batchnumber"),
        "currentmilestone": r.get("currentmilestone"),
        "dosestatus": r.get("dosestatus"),
        "injectiondate": r.get("injectiondate"),
        "carrier": r.get("carrier"),
        "issue_count": len(issues),
    }


# ---------------------------------------------------------------------------
# order lifecycle / data provenance
# ---------------------------------------------------------------------------
# Which source each event came from, in ETL pipeline order. NOTE: the two
# full-load tables carry their ingest time in a TEXT `load_timestamp` column
# (cast to timestamp), every other table uses `audit_timestamp`.
_LOAD_TS = ("(CASE WHEN load_timestamp::text ~ '^\\s*\\d{4}-\\d{2}-\\d{2}' "
            "THEN load_timestamp::text::timestamp END)")

# key, label, table, join column, timestamp expr, kind
LIFECYCLE_STAGES = [
    ("rome", "ROME order", "etl.rome_inbound_orders", "salesordernumber", "audit_timestamp", "inbound"),
    ("rome_reject", "ROME rejects", "etl.rome_inbound_rejects", "salesordernumber", "audit_timestamp", "rejects"),
    ("a2_sales_full", "3A GEST2 sales — full-load", "etl.threeagesttwo_sales_inbound_fullload", "sales_order_id", _LOAD_TS, "inbound"),
    ("a2_sales", "3A GEST2 sales — incremental", "etl.threeagesttwo_sales_inbound", "sales_order_id", "audit_timestamp", "inbound"),
    ("a2_batches_full", "3A GEST2 batches — full-load", "etl.threeagesttwo_batches_inbound_fullload", "sales_order_id", _LOAD_TS, "inbound"),
    ("a2_batches", "3A GEST2 batches — incremental", "etl.threeagesttwo_batches_inbound", "sales_order_id", "audit_timestamp", "inbound"),
    ("carrier", "Carrier events", "etl.carrier_inbound", "salesordernumber", "audit_timestamp", "inbound"),
    ("carrier_reject", "Carrier rejects", "etl.carrier_inbound_rejects", "salesordernumber", "audit_timestamp", "rejects"),
    ("sensitech", "Sensitech pings", "etl.sensitech_inbound_trip", "salesordernumber", "audit_timestamp", "inbound"),
    ("sensitech_reject", "Sensitech rejects", "etl.sensitech_inbound_rejects", "salesordernumber", "audit_timestamp", "rejects"),
]

# inbound stage -> its reject sibling
_REJECT_OF = {"rome": "rome_reject", "carrier": "carrier_reject", "sensitech": "sensitech_reject"}
_TS_BASIS = {"a2_sales_full": "load_timestamp (text)", "a2_batches_full": "load_timestamp (text)"}


@router.get("/{tracking}/lifecycle")
async def shipment_lifecycle(tracking: str):
    """Data-provenance timeline: when each source system's data arrived for
    this order, in ETL pipeline order."""
    _primary, group = await _get_group(tracking)
    ids = sorted({
        v for r in group
        for v in (str(r.get("salesordernumber") or "").strip(),
                  str(r.get("salesordernumber_3a2") or "").strip())
        if v
    })
    if not ids:
        return {"sales_orders": [], "stages": []}

    parts = [
        f"""SELECT '{key}' AS src, COUNT(*) AS n,
                   MIN({ts}) AS first_ts, MAX({ts}) AS last_ts
            FROM {table} WHERE {join}::text = ANY($1::text[])"""
        for key, _label, table, join, ts, _kind in LIFECYCLE_STAGES
    ]
    rows = await fetch_all(" UNION ALL ".join(parts), ids)
    by_src = {r["src"]: r for r in rows}

    def iso(v):
        return v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else None)

    # sample error messages for any reject stage that fired
    reject_msgs: dict[str, Optional[str]] = {}
    for key, _l, table, join, _ts, kind in LIFECYCLE_STAGES:
        if kind == "rejects" and (by_src.get(key, {}).get("n") or 0) > 0:
            m = await fetch_all(
                f"SELECT error_message FROM {table} WHERE {join}::text = ANY($1::text[]) "
                f"AND NULLIF(btrim(error_message::text),'') IS NOT NULL LIMIT 1", ids)
            reject_msgs[key] = (m[0]["error_message"] if m else None)

    stages = []
    for key, label, _table, _join, _ts, kind in LIFECYCLE_STAGES:
        if kind != "inbound":
            continue
        row = by_src.get(key, {})
        n = int(row.get("n") or 0)
        rej_key = _REJECT_OF.get(key)
        rej = by_src.get(rej_key, {}) if rej_key else {}
        rej_n = int(rej.get("n") or 0)
        stages.append({
            "key": key,
            "label": label,
            "received": n > 0,
            "count": n,
            "first_ts": iso(row.get("first_ts")),
            "last_ts": iso(row.get("last_ts")),
            "ts_basis": _TS_BASIS.get(key, "audit_timestamp"),
            "rejected_count": rej_n,
            "reject_last_ts": iso(rej.get("last_ts")) if rej_n else None,
            "reject_message": reject_msgs.get(rej_key) if rej_n else None,
        })
    return {"sales_orders": ids, "stages": stages}


@router.get("/{tracking}/detail")
async def shipment_detail(tracking: str, so: Optional[str] = Query(default=None)):
    row, group = await _get_group(tracking, so)
    issues = q.extract_flags(row)
    shipment = {k: v for k, v in row.items() if not k.startswith("flag_")}

    traces = await trace_missing_fields(shipment)
    rca = None
    if row.get("flag_stale_injection"):
        rca = await stale_injection_rca(shipment)

    return {
        "shipment": shipment,
        "issues": issues,
        "field_traces": traces,
        "stale_injection_rca": rca,
        "related_orders": [_order_summary(r) for r in group],
    }


@router.get("/{tracking}/pings")
async def shipment_pings(tracking: str):
    sp, group = await _get_group(tracking)
    so_list = sorted({
        str(r.get("salesordernumber") or "").strip()
        for r in group
        if str(r.get("salesordernumber") or "").strip()
    })
    # DESC: rows are duplicated once per SO upstream, so if the cap bites it
    # must drop the OLDEST fixes, never the newest (analyze_pings re-sorts).
    rows = await fetch_all(
        """SELECT latitude, longitude, device_date_time, device_ping_date_time,
                  current_address, deviceserialnumber, tripid
           FROM etl.sensitech_inbound_trip
           WHERE salesordernumber::text = ANY($1::text[])
           ORDER BY device_date_time DESC NULLS LAST
           LIMIT 8000""",
        so_list or [tracking],
    )
    # upstream repeats trip rows once per SO — dedupe on (device, times, position);
    # device_ping_date_time is in the key because it's the fallback timestamp
    # for rows whose device_date_time is NULL (distinct pings, same coords)
    seen: set = set()
    unique = []
    for r in rows:
        key = (r.get("deviceserialnumber"), r.get("device_date_time"),
               r.get("device_ping_date_time"),
               str(r.get("latitude")), str(r.get("longitude")))
        if key in seen:
            continue
        seen.add(key)
        unique.append(r)
    analysis = analyze_pings(unique)

    # carrier-reported flight legs (authoritative IATA info when present)
    flight_rows = await fetch_all(
        """SELECT DISTINCT departure_airport_iata, arrival_airport_iata,
                  flightnumber, flight_details
           FROM etl.carrier_inbound
           WHERE salesordernumber::text = ANY($1::text[])
             AND (NULLIF(btrim(departure_airport_iata::text),'') IS NOT NULL
                  OR NULLIF(btrim(arrival_airport_iata::text),'') IS NOT NULL)
           LIMIT 20""",
        so_list or [tracking],
    )
    reported_flights = []
    for f in flight_rows:
        dep = airports.by_iata(f.get("departure_airport_iata"))
        arr = airports.by_iata(f.get("arrival_airport_iata"))
        reported_flights.append({
            "flightnumber": f.get("flightnumber"),
            "flight_details": (str(f.get("flight_details"))[:200] if f.get("flight_details") else None),
            "departure_iata": f.get("departure_airport_iata"),
            "arrival_iata": f.get("arrival_airport_iata"),
            "departure_airport": dep,
            "arrival_airport": arr,
        })

    dest = {
        "lat": parse_coord(sp.get("destinationlatitude")),
        "lon": parse_coord(sp.get("destinationlongitude")),
        "name": sp.get("destinationname"),
        "address": sp.get("destinationaddress"),
    }
    origin = {
        "lat": parse_coord(sp.get("originlatitude")),
        "lon": parse_coord(sp.get("originlongitude")),
        "name": sp.get("origin"),
        "address": sp.get("originaddress"),
    }
    return {
        "salesordernumber": sp.get("salesordernumber"),
        "sales_orders": so_list,
        "trackingnumber": sp.get("trackingnumber"),
        "destination": dest if valid_lat_lon(dest["lat"], dest["lon"]) else {**dest, "lat": None, "lon": None},
        "origin": origin if valid_lat_lon(origin["lat"], origin["lon"]) else {**origin, "lat": None, "lon": None},
        "reported_flights": reported_flights,
        **analysis,
    }


@router.get("/{tracking}/milestones")
async def shipment_milestones(tracking: str, so: Optional[str] = Query(default=None)):
    sp, _group = await _get_group(tracking, so)
    so_num = str(sp.get("salesordernumber") or "").strip()
    mode = infer_mode(sp)
    mappings = await load_mappings()

    raw_events = await fetch_all(
        """SELECT carriername, "event", event_description, eventtimestamp,
                  audit_timestamp, flightnumber, airway_bill_no,
                  departure_airport_iata, arrival_airport_iata, delay_reason
           FROM etl.carrier_inbound
           WHERE salesordernumber::text = $1
           ORDER BY eventtimestamp ASC NULLS LAST, audit_timestamp ASC NULLS LAST
           LIMIT 500""",
        so_num,
    )
    validation = validate_events(raw_events, sp.get("carrier"), mode, mappings)

    processed = await fetch_all(
        """SELECT salesordernumber, carriername, "event", event_description,
                  milestone, milestone_flag, currentstep, event_timestamp,
                  event_timestamp_local, audittimestamp, flightnumber,
                  departureairport_iata, arrivalairport_iata, currentleg,
                  totallegs, multileg, milestonetype
           FROM etl.order_milestone_history
           WHERE salesordernumber::text = $1
           ORDER BY event_timestamp ASC NULLS LAST
           LIMIT 300""",
        so_num,
    )

    # expected milestone ladder for this carrier+mode, for the timeline UI
    carrier_key = str(sp.get("carrier") or "").strip().upper()
    if not carrier_key and raw_events:
        carrier_key = str(raw_events[0].get("carriername") or "").strip().upper()
    ladder: list[dict] = []
    seen_ui: set = set()
    carrier_map = mappings.get(mode, {}).get(carrier_key, {})
    for info in sorted(
        (v for v in carrier_map.values() if v.get("step") is not None and (v.get("flag") or 0) > 0),
        key=lambda v: v["step"],
    ):
        ui = info.get("ui_milestone")
        if ui and ui not in seen_ui:
            seen_ui.add(ui)
            ladder.append({"ui_milestone": ui, "flag": info.get("flag"), "first_step": info.get("step")})

    return {
        "salesordernumber": so_num,
        "carrier": sp.get("carrier"),
        "mode": mode,
        "current_milestone": sp.get("currentmilestone"),
        "current_step": sp.get("currentmilestonestep"),
        "expected_ladder": ladder,
        "raw_events": validation["events"],
        "sequence_issues": validation["issues"],
        "processed_milestones": processed,
    }
