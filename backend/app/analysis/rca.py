"""Root-cause analysis helpers.

Two jobs:

1. trace_missing_fields(shipment): for each blank field on the shipment row,
   look upstream — did the source system send it (inbound table), did it get
   rejected (reject table with error_message), or was it never received?

2. stale_injection_rca(shipment): the injection date is in the past but the
   shipment isn't closed. Walk the evidence (ROME cancellation, carrier
   delivery events, sensitech last fix vs destination geofence, upstream
   silence) and produce a verdict + evidence trail.
"""
from datetime import datetime, timezone
from typing import Optional

from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..geo import haversine_km, parse_coord, valid_lat_lon

def _s(v) -> str:
    return "" if v is None else str(v).strip()


def _blank(v) -> bool:
    return _s(v) == ""


def _to_dt(v) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


# --------------------------------------------------------------------------
# 1. field-level source tracing
# --------------------------------------------------------------------------
async def trace_missing_fields(sp: dict) -> list[dict]:
    so = _s(sp.get("salesordernumber"))
    so_3a2 = _s(sp.get("salesordernumber_3a2")) or so
    traces: list[dict] = []
    if not so:
        return traces

    async def add(field: str, finding: str, source: str, detail: str, found: bool):
        traces.append({
            "field": field, "finding": finding, "source": source,
            "detail": detail, "found_upstream": found,
        })

    # ---- batch number ------------------------------------------------------
    if _blank(sp.get("batchnumber")):
        row = await fetch_one(
            """SELECT batch_no, batch_status, sales_order_id, updatedt
               FROM etl.threeagesttwo_batches_inbound
               WHERE sales_order_id::text IN ($1, $2) AND NULLIF(btrim(batch_no::text),'') IS NOT NULL
               ORDER BY updatedt DESC NULLS LAST LIMIT 1""", so, so_3a2)
        if row:
            await add("batchnumber", "present_upstream", "threeagesttwo_batches_inbound",
                      f"Batch {row['batch_no']} (status {row['batch_status']}) exists upstream — "
                      "ETL/join into etl.shipment did not pick it up", True)
        else:
            row = await fetch_one(
                """SELECT batch_no, batch_status, load_timestamp
                   FROM etl.threeagesttwo_batches_inbound_fullload
                   WHERE sales_order_id::text IN ($1, $2) AND NULLIF(btrim(batch_no::text),'') IS NOT NULL
                   ORDER BY load_timestamp DESC NULLS LAST LIMIT 1""", so, so_3a2)
            if row:
                await add("batchnumber", "present_in_fullload_only", "threeagesttwo_batches_inbound_fullload",
                          f"Batch {row['batch_no']} only in full-load snapshot — incremental feed "
                          "(HVR) likely missed this order", True)
            else:
                await add("batchnumber", "never_received", "3A GEST2",
                          "No batch row for this sales order in incremental or full-load tables — "
                          "batch not created/sent by 3A GEST2 yet", False)

    # ---- carrier -----------------------------------------------------------
    if _blank(sp.get("carrier")):
        row = await fetch_one(
            """SELECT carriername, MAX(audit_timestamp) AS last_seen, COUNT(*) AS n
               FROM etl.carrier_inbound WHERE salesordernumber::text = $1
               GROUP BY carriername ORDER BY last_seen DESC NULLS LAST LIMIT 1""", so)
        if row:
            await add("carrier", "present_upstream", "carrier_inbound",
                      f"{row['n']} events from {row['carriername']} exist (last {row['last_seen']}) — "
                      "shipment row not updated with carrier", True)
        else:
            rej = await fetch_one(
                """SELECT carriername, error_message, MAX(audit_timestamp) AS last_seen, COUNT(*) AS n
                   FROM etl.carrier_inbound_rejects WHERE salesordernumber::text = $1
                   GROUP BY carriername, error_message ORDER BY last_seen DESC NULLS LAST LIMIT 1""", so)
            if rej:
                await add("carrier", "rejected", "carrier_inbound_rejects",
                          f"{rej['n']} event(s) from {_s(rej['carriername']) or '?'} REJECTED: "
                          f"{_s(rej['error_message'])[:300]}", True)
            else:
                await add("carrier", "never_received", "carrier feeds",
                          "No rows in carrier_inbound or carrier_inbound_rejects — no carrier "
                          "has sent anything for this sales order", False)

    # ---- ROME-sourced fields (planned delivery / injection date / addresses)
    rome_fields = [f for f in ("planneddeliverydate", "injectiondate", "destinationaddress")
                   if _blank(sp.get(f))]
    if rome_fields:
        row = await fetch_one(
            """SELECT orderstatus, deliverydate, injectiondate, cancellationdate, audit_timestamp
               FROM etl.rome_inbound_orders WHERE salesordernumber::text = $1
               ORDER BY audit_timestamp DESC NULLS LAST LIMIT 1""", so)
        if row:
            for f in rome_fields:
                src_val = row["deliverydate"] if f == "planneddeliverydate" else row.get(f)
                if f == "destinationaddress":
                    src_val = "delivery address fields"
                if src_val is not None and not _blank(src_val):
                    await add(f, "present_upstream", "rome_inbound_orders",
                              f"ROME order (status {row['orderstatus']}) carries this value — "
                              "not propagated to etl.shipment", True)
                else:
                    await add(f, "blank_at_source", "rome_inbound_orders",
                              f"ROME order exists (status {row['orderstatus']}) but this field is "
                              "blank at the source too", True)
        else:
            rej = await fetch_one(
                """SELECT error_message, audit_timestamp FROM etl.rome_inbound_rejects
                   WHERE salesordernumber::text = $1
                   ORDER BY audit_timestamp DESC NULLS LAST LIMIT 1""", so)
            for f in rome_fields:
                if rej:
                    await add(f, "rejected", "rome_inbound_rejects",
                              f"ROME order REJECTED: {_s(rej['error_message'])[:300]}", True)
                else:
                    await add(f, "never_received", "ROME",
                              "No ROME order (inbound or rejected) for this sales order", False)

    # ---- sensitech / GPS ----------------------------------------------------
    if _blank(sp.get("lastgps")) or _blank(sp.get("currentlatitude")):
        row = await fetch_one(
            """SELECT COUNT(*) AS n, MAX(device_date_time) AS last_fix
               FROM etl.sensitech_inbound_trip WHERE salesordernumber::text = $1""", so)
        if row and (row["n"] or 0) > 0:
            await add("gps", "present_upstream", "sensitech_inbound_trip",
                      f"{row['n']} pings exist (last {row['last_fix']}) — shipment row GPS "
                      "columns not refreshed", True)
        else:
            rej = await fetch_one(
                """SELECT error_message, COUNT(*) AS n FROM etl.sensitech_inbound_rejects
                   WHERE salesordernumber::text = $1 GROUP BY error_message
                   ORDER BY n DESC LIMIT 1""", so)
            if rej:
                await add("gps", "rejected", "sensitech_inbound_rejects",
                          f"{rej['n']} ping(s) REJECTED: {_s(rej['error_message'])[:300]}", True)
            else:
                await add("gps", "never_received", "Sensitech",
                          "No pings in sensitech_inbound_trip or _rejects — device never "
                          "reported for this sales order", False)

    # ---- flight number on air shipments -------------------------------------
    if _blank(sp.get("flightnumber")):
        row = await fetch_one(
            """SELECT flightnumber, flight_details, departure_airport_iata, arrival_airport_iata
               FROM etl.carrier_inbound
               WHERE salesordernumber::text = $1
                 AND (NULLIF(btrim(flightnumber::text),'') IS NOT NULL
                      OR NULLIF(btrim(flight_details::text),'') IS NOT NULL)
               ORDER BY audit_timestamp DESC NULLS LAST LIMIT 1""", so)
        if row:
            await add("flightnumber", "present_upstream", "carrier_inbound",
                      f"Carrier sent flight info ({_s(row['flightnumber']) or _s(row['flight_details'])[:80]}"
                      f" {_s(row['departure_airport_iata'])}->{_s(row['arrival_airport_iata'])}) — "
                      "not on shipment row", True)

    return traces


# --------------------------------------------------------------------------
# 2. stale-injection RCA
# --------------------------------------------------------------------------
async def stale_injection_rca(sp: dict) -> dict:
    s = get_settings()
    so = _s(sp.get("salesordernumber"))
    evidence: list[dict] = []
    verdict = "unexplained"
    verdict_label = "Unexplained — needs manual investigation"

    def ev(source: str, finding: str, detail: str):
        evidence.append({"source": source, "finding": finding, "detail": detail})

    # 1) cancelled upstream?
    rome = await fetch_one(
        """SELECT orderstatus, orderstatuscategory, cancellationdate, latesterpstatus, audit_timestamp
           FROM etl.rome_inbound_orders WHERE salesordernumber::text = $1
           ORDER BY audit_timestamp DESC NULLS LAST LIMIT 1""", so)
    if rome:
        status = _s(rome["orderstatus"]) + " / " + _s(rome["orderstatuscategory"])
        ev("ROME", "order_found", f"Latest ROME status: {status}, ERP: {_s(rome['latesterpstatus'])}")
        if not _blank(rome["cancellationdate"]) or "cancel" in status.lower():
            verdict = "cancelled_upstream"
            verdict_label = "Cancelled in ROME — shipment row never closed"
            ev("ROME", "cancelled", f"cancellationdate={rome['cancellationdate']}, status={status}")
    else:
        ev("ROME", "no_order", "No ROME order found for this sales order")

    # 2) carrier says delivered?
    if verdict == "unexplained":
        deliv = await fetch_one(
            """SELECT "event", eventtimestamp, actual_deliverytime, pod_name
               FROM etl.carrier_inbound
               WHERE salesordernumber::text = $1
                 AND ("event" ILIKE '%deliver%' OR "event" ILIKE '%completed%'
                      OR NULLIF(btrim(actual_deliverytime::text),'') IS NOT NULL
                      OR NULLIF(btrim(pod_name::text),'') IS NOT NULL)
               ORDER BY eventtimestamp DESC NULLS LAST LIMIT 1""", so)
        if deliv:
            verdict = "delivered_not_closed"
            verdict_label = "Carrier reported delivery — milestone/status never updated"
            ev("Carrier", "delivery_event",
               f"'{deliv['event']}' at {deliv['eventtimestamp']}, actual_delivery="
               f"{deliv['actual_deliverytime']}, POD={_s(deliv['pod_name']) or 'none'}")

    # 3) sensitech story: silent? stuck? reached geofence?
    pings = await fetch_all(
        """SELECT latitude, longitude, device_date_time
           FROM etl.sensitech_inbound_trip WHERE salesordernumber::text = $1
           ORDER BY device_date_time DESC NULLS LAST LIMIT 500""", so)
    dest_lat = parse_coord(sp.get("destinationlatitude"))
    dest_lon = parse_coord(sp.get("destinationlongitude"))
    if not pings:
        ev("Sensitech", "no_pings", "Device never sent a single ping for this sales order")
        if verdict == "unexplained":
            verdict = "no_sensitech_data"
            verdict_label = "No Sensitech data ever received — tracking blind"
    else:
        last = pings[0]
        last_ts = _to_dt(last["device_date_time"])
        age_h = None
        if last_ts:
            now = datetime.now(timezone.utc)
            if last_ts.tzinfo is None:
                now = datetime.now()
            age_h = round((now - last_ts).total_seconds() / 3600.0, 1)
        ev("Sensitech", "last_ping", f"{len(pings)}+ pings; last fix {last['device_date_time']}"
           + (f" ({age_h}h ago)" if age_h is not None else ""))
        # position check uses the newest ping with *valid* coordinates
        # (the very last row can be a (0,0)/null ghost)
        pos = next(
            (p for p in pings
             if valid_lat_lon(parse_coord(p["latitude"]), parse_coord(p["longitude"]))),
            last,
        )
        llat, llon = parse_coord(pos["latitude"]), parse_coord(pos["longitude"])
        if valid_lat_lon(llat, llon) and valid_lat_lon(dest_lat, dest_lon):
            dist = haversine_km(llat, llon, dest_lat, dest_lon)
            thr = parse_coord(sp.get("dist_threshold")) or s.default_geofence_km
            ev("Geofence", "distance_to_destination",
               f"Last fix is {round(dist, 2)} km from destination (threshold {thr} km)")
            if dist <= thr and verdict == "unexplained":
                verdict = "arrived_no_pod"
                verdict_label = ("Device reached destination geofence — likely delivered, "
                                 "delivery confirmation/POD missing")
        if verdict == "unexplained" and age_h is not None and age_h > 24:
            verdict = "gps_lost_in_transit"
            verdict_label = "GPS went silent mid-journey — device died or trip not closed"

    # 4) any carrier events at all?
    if verdict in ("unexplained", "gps_lost_in_transit", "no_sensitech_data"):
        n_ev = await fetch_one(
            """SELECT COUNT(*) AS n, MAX(eventtimestamp) AS last_event
               FROM etl.carrier_inbound WHERE salesordernumber::text = $1""", so)
        if n_ev and (n_ev["n"] or 0) == 0:
            ev("Carrier", "silent", "Zero carrier events — carrier never picked this up in their system")
            if verdict == "unexplained":
                verdict = "carrier_silent"
                verdict_label = "No carrier events at all — booking may never have reached the carrier"
        elif n_ev:
            ev("Carrier", "events_exist", f"{n_ev['n']} carrier events, last at {n_ev['last_event']}")

    # 5) rejects on any feed add color regardless of verdict
    for table, label in (("etl.carrier_inbound_rejects", "Carrier rejects"),
                         ("etl.rome_inbound_rejects", "ROME rejects"),
                         ("etl.sensitech_inbound_rejects", "Sensitech rejects")):
        rej = await fetch_one(
            f"""SELECT COUNT(*) AS n, MAX(error_message) AS msg FROM {table}
                WHERE salesordernumber::text = $1""", so)
        if rej and (rej["n"] or 0) > 0:
            ev(label, "rejects_found", f"{rej['n']} rejected row(s), e.g.: {_s(rej['msg'])[:200]}")

    return {
        "verdict": verdict,
        "verdict_label": verdict_label,
        "injectiondate": _s(sp.get("injectiondate")) or None,
        "evidence": evidence,
    }
