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

from datetime import datetime, timedelta, timezone

from .. import airports, decay
from ..cache import cached
from ..config import get_settings
from ..db import fetch_all
from ..analysis import quality as q
from ..analysis.ghost import analyze_pings
from ..analysis.milestones import infer_mode, load_mappings, validate_events
from ..analysis.rca import stale_injection_rca, trace_missing_fields
from ..geo import parse_coord, valid_lat_lon

router = APIRouter(prefix="/api/shipments", tags=["shipment-detail"])


def _dt(v):
    """Parse to a naive-UTC datetime. asyncpg returns timestamptz as tz-aware
    UTC; text columns may carry any offset (e.g. '+02:00'). We convert aware
    values to UTC *before* dropping tzinfo so every datetime the dose math sees
    lives in one consistent naive-UTC space (matching now = utcnow)."""
    if v is None:
        return None
    d = v if isinstance(v, datetime) else None
    if d is None:
        try:
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is not None:
        d = d.astimezone(timezone.utc)
    return d.replace(tzinfo=None)


def _iso_z(d):
    """ISO-8601 stamped with an explicit UTC 'Z'. Our datetimes are naive-UTC
    (see _dt / now=utcnow); emitting the marker makes the frontend read the same
    instant whether it goes through new Date() (fmt.dt) or parseTs."""
    return (d.isoformat() + "Z") if d is not None else None


def _combine_date_time(date_v, time_v):
    import re
    d = _dt(date_v)
    if not d:
        m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", str(date_v or ""))
        if m:
            d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
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
            if 0 <= h <= 23:
                return d.replace(hour=h, minute=mn)
    return d


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
# decay & dose intelligence
# ---------------------------------------------------------------------------
# Activity columns are OPTIONAL on the real schema — we never assume they
# exist. We read information_schema first and NULL-alias whatever is absent,
# so a table without dose data degrades to has_dose:false instead of 500-ing.
_DOSE_VALUE_COLS = ["planned_activity", "planned_mbq", "mbq", "gbq", "mci"]
_DOSE_META_COLS = ["batch_no", "tinj_datetime", "texp", "volume",
                   "batch_status", "production_site"]


async def _table_columns(table: str) -> set[str]:
    rows = await fetch_all(
        """SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'etl' AND table_name = $1""",
        table,
    )
    return {str(r["column_name"]).lower() for r in rows}


async def _fetch_batch_activity(so_list: list[str]) -> Optional[dict]:
    """Best-available batch row carrying dose data, over the incremental table
    then the full-load fallback. Column-set is discovered at runtime so the
    query only ever names columns that exist."""
    for table, order_cands in (
        ("threeagesttwo_batches_inbound", ("updatedt", "audit_timestamp")),
        ("threeagesttwo_batches_inbound_fullload", ("load_timestamp", "audit_timestamp")),
    ):
        present = await cached(f"batchcols:{table}", 600, lambda t=table: _table_columns(t))
        value_cols = [c for c in _DOSE_VALUE_COLS if c in present]
        # need both an activity column AND the join key, else this table can't
        # answer the query — skip it and degrade rather than 500 on the miss.
        if not value_cols or "sales_order_id" not in present:
            continue
        wanted = ["sales_order_id"] + _DOSE_VALUE_COLS + _DOSE_META_COLS
        select = ", ".join(c if c in present else f"NULL AS {c}" for c in wanted)
        # ::text before COALESCE so a mixed numeric/text column layout on the
        # real schema can't raise "COALESCE types ... cannot be matched".
        coalesce = "COALESCE(" + ", ".join(f"{c}::text" for c in value_cols) + ") IS NOT NULL"
        order_col = next((c for c in order_cands if c in present), None)
        order = f"ORDER BY {order_col} DESC NULLS LAST" if order_col else ""
        rows = await fetch_all(
            f"""SELECT {select} FROM etl.{table}
                WHERE sales_order_id::text = ANY($1::text[]) AND {coalesce}
                {order} LIMIT 1""",
            so_list,
        )
        if rows:
            return rows[0]
    return None


@router.get("/{tracking}/dose")
async def shipment_dose(tracking: str, so: Optional[str] = Query(default=None)):
    """Radioactive-decay / delivered-activity model for the dose. All inputs
    are existing batch columns (mbq/gbq/mci/planned_activity/tinj_datetime);
    the physics is deterministic (no ML, no DB change)."""
    sp, group = await _get_group(tracking, so)

    # 3A GEST2 batch rows key on sales_order_id, which can match EITHER the ROME
    # salesordernumber OR salesordernumber_3a2 — mirror lifecycle/rca and try
    # both, else the panel silently vanishes for 3a2-keyed orders.
    def _ids(r: dict) -> list[str]:
        return [str(r.get(c) or "").strip()
                for c in ("salesordernumber", "salesordernumber_3a2")]

    primary_ids = [v for v in _ids(sp) if v]
    group_ids = sorted({v for r in group for v in _ids(r) if v})

    # prefer the selected/primary order's own batch; widen to the trip group
    # only if that order carries no activity data.
    b = await _fetch_batch_activity(primary_ids) if primary_ids else None
    if not b and group_ids:
        b = await _fetch_batch_activity(group_ids)

    isotope = decay.isotope_for_product(sp.get("product"))
    hl = decay.half_life_hours(isotope)
    now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive-UTC, matches _dt

    if not b:
        return {
            "has_dose": False, "isotope": isotope, "half_life_hours": round(hl, 2),
            "reason": "No batch activity (mbq/gbq/planned_activity) found for this order in 3A GEST2.",
        }

    a0 = (decay._num(b.get("planned_activity")) or decay._num(b.get("planned_mbq"))
          or decay.as_mbq(b.get("mbq"), b.get("gbq"), b.get("mci")))
    # calibration reference = scheduled injection time (batch tinj, else shipment)
    t0 = _dt(b.get("tinj_datetime")) or _combine_date_time(sp.get("injectiondate"), sp.get("injectiontime"))
    if a0 is None or t0 is None:
        return {
            "has_dose": False, "isotope": isotope, "half_life_hours": round(hl, 2),
            "reason": "Batch found but prescribed activity or injection/calibration time is missing.",
        }

    tol = get_settings().__dict__.get("dose_tolerance", 0.10) or 0.10
    usable_low = a0 * (1 - tol)
    usable_high = a0 * (1 + tol)
    # activity stays usable until this many hours after calibration
    usable_margin_h = decay.hours_to_fraction(hl, 1 - tol)
    usable_until = t0 + timedelta(hours=usable_margin_h)

    eta = _dt(sp.get("etadeliverytime"))
    act_now = decay.activity_at(a0, t0, now, hl)
    act_eta = decay.activity_at(a0, t0, eta, hl) if eta else None

    if act_now < usable_low:
        verdict, verdict_label = "underdosed", "Below usable activity now — likely wasted"
    elif eta and act_eta is not None and act_eta < usable_low:
        verdict, verdict_label = "will_underdose", "Projected to arrive below usable activity"
    elif act_now > usable_high:
        verdict, verdict_label = "pre_window", "More active than prescribed (before injection window)"
    else:
        verdict, verdict_label = "in_window", "Within the usable activity window"

    span_start = min(t0 - timedelta(days=3), now - timedelta(days=1))
    span_end = max(usable_until + timedelta(hours=12), now + timedelta(hours=6),
                   (eta + timedelta(hours=6)) if eta else now)
    curve = decay.build_curve(a0, t0, hl, span_start, span_end, points=64)

    return {
        "has_dose": True,
        "isotope": isotope,
        "half_life_hours": round(hl, 2),
        "batch_no": b.get("batch_no"),
        "production_site": b.get("production_site"),
        "volume_ml": decay._num(b.get("volume")),
        "prescribed_mbq": round(a0, 1),
        "prescribed_gbq": decay.fmt_gbq(a0),
        "prescribed_mci": decay.fmt_mci(a0),
        "calibration_time": _iso_z(t0),               # = scheduled injection time (UTC)
        "now": _iso_z(now),                            # server clock, naive-UTC
        "activity_now_mbq": round(act_now, 1),
        "activity_now_pct": round(100.0 * act_now / a0, 1),
        "eta": _iso_z(eta),
        "activity_at_eta_mbq": round(act_eta, 1) if act_eta is not None else None,
        "activity_at_eta_pct": round(100.0 * act_eta / a0, 1) if act_eta is not None else None,
        "tolerance": tol,
        "usable_low_mbq": round(usable_low, 1),
        "usable_high_mbq": round(usable_high, 1),
        "usable_until": _iso_z(usable_until),
        "decay_margin_hours": round((usable_until - now).total_seconds() / 3600.0, 1),
        "vial_expiry": _iso_z(_dt(b.get("texp"))),
        "verdict": verdict,
        "verdict_label": verdict_label,
        "curve": curve,
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
