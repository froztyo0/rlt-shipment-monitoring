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
    rows = await fetch_all(
        """SELECT latitude, longitude, device_date_time, device_ping_date_time,
                  current_address, deviceserialnumber, tripid
           FROM etl.sensitech_inbound_trip
           WHERE salesordernumber::text = ANY($1::text[])
           ORDER BY device_date_time ASC NULLS LAST
           LIMIT 8000""",
        so_list or [tracking],
    )
    # upstream repeats trip rows once per SO — dedupe on (device, time, position)
    seen: set = set()
    unique = []
    for r in rows:
        key = (r.get("deviceserialnumber"), r.get("device_date_time"),
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
