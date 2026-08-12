"""Dead-Reckoning ETA & Stall board.

The injection-risk board trusts the carrier's ETA verbatim. This computes an
INDEPENDENT ETA straight from the raw GPS trail: closing speed = the rate at
which haversine distance-to-destination is shrinking, so remaining distance /
recent closing speed = a physics ETA that owes nothing to the carrier's promise.
Closing speed also separates 'moving but not toward the patient' (real ground
speed, ~zero closing speed) from genuine progress, and a stall detector catches
a dose that is stuck-but-still-pinging — neither of which ghost detection sees.

Read-only, bounded (active window + a set-based ping pull for that SO set),
computed in Python with the existing geo/haversine helpers.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query

from ..cache import cached
from ..config import get_settings
from ..db import fetch_all
from ..analysis import quality as q
from ..geo import haversine_km, parse_coord, valid_lat_lon

router = APIRouter(prefix="/api/dead-reckoning", tags=["dead-reckoning"])

MOVING_KMH = 8.0       # ground speed above this = "actually moving"
CLOSING_MIN_KMH = 0.5  # closing speed below this = "not approaching"
PROGRESS_KM = 2.0      # distance drop that counts as real progress
STALL_MIN_H = 3.0      # no progress for this long = stalled


def _naive_dt(v) -> Optional[datetime]:
    if v is None:
        return None
    d = v if isinstance(v, datetime) else None
    if d is None:
        try:
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None
    if d.tzinfo is not None:
        d = d.astimezone(timezone.utc)
    return d.replace(tzinfo=None)


def _deadline(date_v, time_v) -> Optional[datetime]:
    import re
    d = _naive_dt(date_v)
    if not d:
        m = re.match(r"\s*(\d{4})-(\d{1,2})-(\d{1,2})", str(date_v or ""))
        if not m:
            return None
        d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    d = d.replace(hour=0, minute=0, second=0, microsecond=0)
    m = re.search(r"(\d{1,2}):(\d{2})\s*([AaPp][Mm])?", str(time_v or ""))
    if m:
        h, mn, ap = int(m.group(1)), int(m.group(2)), (m.group(3) or "").upper()
        if ap == "PM" and h < 12:
            h += 12
        elif ap == "AM" and h == 12:
            h = 0
        if 0 <= h <= 23:
            return d.replace(hour=h, minute=mn)
    return d.replace(hour=12)


@router.get("")
async def dead_reckoning(days_back: int = Query(default=3, ge=0, le=30),
                         days_fwd: int = Query(default=21, ge=1, le=90)):
    return await cached(f"deadreck:{days_back}:{days_fwd}", 60,
                        lambda: _compute(days_back, days_fwd))


async def _compute(days_back: int, days_fwd: int):
    gps_stale_h = get_settings().gps_stale_hours
    ships = await fetch_all(f"""
        SELECT s.salesordernumber, s.trackingnumber, s.product, s.carrier,
               s.destinationname, s.destinationlatitude, s.destinationlongitude,
               s.distance, s.etadeliverytime, s.injectiondate, s.injectiontime,
               s.vialexpirationtime, s.currentmilestone, s.lastgps
        FROM etl.shipment s
        WHERE {q.ACTIVE_SQL}
          AND NULLIF(btrim(s.actualdeparted::text), '') IS NOT NULL
          AND s.injectiondate::text ~ '^\\s*\\d{{4}}-\\d{{2}}-\\d{{2}}'
          AND s.injectiondate::date BETWEEN CURRENT_DATE - {int(days_back)}
                                        AND CURRENT_DATE + {int(days_fwd)}
        ORDER BY s.injectiondate::date ASC
        LIMIT 600
    """)

    so_ids = sorted({str(s["salesordernumber"] or "").strip() for s in ships
                     if str(s["salesordernumber"] or "").strip()})
    pings_by_so: dict[str, list] = {}
    if so_ids:
        prows = await fetch_all("""
            SELECT salesordernumber, latitude, longitude, device_date_time
            FROM etl.sensitech_inbound_trip
            WHERE salesordernumber::text = ANY($1::text[])
            ORDER BY device_date_time ASC NULLS LAST
        """, so_ids)
        for p in prows:
            lat, lon = parse_coord(p["latitude"]), parse_coord(p["longitude"])
            t = _naive_dt(p["device_date_time"])
            if valid_lat_lon(lat, lon) and t is not None:
                pings_by_so.setdefault(str(p["salesordernumber"] or "").strip(), []).append((t, lat, lon))

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    items = []
    for s in ships:
        so = str(s["salesordernumber"] or "").strip()
        dlat, dlon = parse_coord(s["destinationlatitude"]), parse_coord(s["destinationlongitude"])
        pts = pings_by_so.get(so, [])
        deadline = _deadline(s["injectiondate"], s["injectiontime"])
        carrier_eta = _naive_dt(s["etadeliverytime"])
        vial = _naive_dt(s["vialexpirationtime"])

        row = {
            "salesordernumber": so, "trackingnumber": s["trackingnumber"],
            "product": s["product"], "carrier": s["carrier"],
            "destinationname": s["destinationname"], "currentmilestone": s["currentmilestone"],
            "injection_deadline": deadline.isoformat() + "Z" if deadline else None,
            "carrier_eta": carrier_eta.isoformat() + "Z" if carrier_eta else None,
            "pings": len(pts),
        }

        if not valid_lat_lon(dlat, dlon) or len(pts) < 2:
            row.update({"verdict": "insufficient_gps", "gps_eta": None,
                        "closing_kmh": None, "remaining_km": None, "route_pct": None,
                        "stall_hours": None, "last_ping_age_h": None})
            items.append(row)
            continue

        dists = [haversine_km(lat, lon, dlat, dlon) for (_t, lat, lon) in pts]
        current = dists[-1]
        initial = max(dists[0], parse_coord(s["distance"]) or 0.0) or dists[0]
        last_t = pts[-1][0]
        last_age_h = (now - last_t).total_seconds() / 3600.0

        # recent window = pings in the last RECENT_H hours (≥2), so a genuine
        # stall reads as ~zero closing instead of being averaged out by an
        # earlier moving leg. Falls back to the last two pings when sparse.
        RECENT_H = 2.5
        cutoff = now - timedelta(hours=RECENT_H)
        recent = [i for i in range(len(pts)) if pts[i][0] >= cutoff]
        w = recent[0] if len(recent) >= 2 else len(pts) - 2
        span_h = (pts[-1][0] - pts[w][0]).total_seconds() / 3600.0
        closing = (dists[w] - dists[-1]) / span_h if span_h > 0.05 else 0.0
        ground = 0.0
        if span_h > 0.05:
            gd = sum(haversine_km(pts[i - 1][1], pts[i - 1][2], pts[i][1], pts[i][2])
                     for i in range(w + 1, len(pts)))
            ground = gd / span_h

        # last real progress → stall clock
        stall_since = pts[0][0]
        for i in range(len(pts) - 1, 0, -1):
            if dists[i - 1] - dists[i] >= PROGRESS_KM:
                stall_since = pts[i][0]
                break
        stall_h = (now - stall_since).total_seconds() / 3600.0

        gps_eta = None
        if closing >= CLOSING_MIN_KMH:
            gps_eta = last_t + _hours(current / closing)
        route_pct = round(100 * max(0.0, min(1.0, 1 - current / initial)), 0) if initial else None

        if last_age_h > gps_stale_h:
            verdict = "gps_stale"
        elif ground > MOVING_KMH and closing < CLOSING_MIN_KMH:
            verdict = "moving_wrong_way"
        elif closing < CLOSING_MIN_KMH and ground <= MOVING_KMH and stall_h > STALL_MIN_H:
            verdict = "stalled"
        elif gps_eta and ((deadline and gps_eta > deadline) or (vial and gps_eta > vial)):
            verdict = "will_miss_gps"
        elif gps_eta is None:
            verdict = "no_closing"
        else:
            verdict = "on_track"

        gps_slack_h = round((deadline - gps_eta).total_seconds() / 3600.0, 1) if (deadline and gps_eta) else None
        eta_gap_h = round((gps_eta - carrier_eta).total_seconds() / 3600.0, 1) if (gps_eta and carrier_eta) else None

        row.update({
            "verdict": verdict,
            "gps_eta": gps_eta.isoformat() + "Z" if gps_eta else None,
            "closing_kmh": round(closing, 1), "ground_kmh": round(ground, 1),
            "remaining_km": round(current, 0), "route_pct": route_pct,
            "stall_hours": round(stall_h, 1), "last_ping_age_h": round(last_age_h, 1),
            "gps_slack_h": gps_slack_h, "eta_gap_h": eta_gap_h,
            "miss_vial": bool(vial and gps_eta and gps_eta > vial),
        })
        items.append(row)

    rank = {"stalled": 0, "moving_wrong_way": 1, "will_miss_gps": 2, "gps_stale": 3,
            "no_closing": 4, "on_track": 5, "insufficient_gps": 6}
    items.sort(key=lambda r: (rank.get(r["verdict"], 9),
                              r["gps_slack_h"] if r.get("gps_slack_h") is not None else 1e9))

    summary = {
        "tracked": sum(1 for r in items if r["verdict"] not in ("insufficient_gps",)),
        "stalled": sum(1 for r in items if r["verdict"] == "stalled"),
        "wrong_way": sum(1 for r in items if r["verdict"] == "moving_wrong_way"),
        "will_miss_gps": sum(1 for r in items if r["verdict"] == "will_miss_gps"),
        "gps_stale": sum(1 for r in items if r["verdict"] == "gps_stale"),
        "on_track": sum(1 for r in items if r["verdict"] == "on_track"),
    }
    return {"window": {"days_back": days_back, "days_fwd": days_fwd},
            "gps_stale_hours": gps_stale_h, "summary": summary, "items": items}


def _hours(h: float):
    from datetime import timedelta
    return timedelta(hours=max(0.0, min(24 * 60, h)))   # clamp runaway ETAs
