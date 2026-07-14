"""Ghost-ping detection and flight-segment inference over Sensitech pings.

Input: pings ordered by device time, each {lat, lon, ts, ...}.

Ghost heuristics (each flagged ping carries its reasons):
  - invalid_coords : null / out-of-range / (0,0) coordinates
  - teleport       : implied speed above GHOST_MAX_SPEED_KMH (faster than a
                     commercial flight) — physically impossible
  - short_hop      : 300..max speed but the jump is < 80 km — real aircraft
                     don't do fast short hops; this is GPS scatter
  - bounce         : A->B->A pattern: bearing reverses ~180 deg with high
                     speeds both ways and near-zero net displacement
  - time_conflict  : same timestamp as previous ping but > 1 km away

Flight segments: a gap between consecutive *clean* pings of >= 25 min with
distance >= 150 km and implied speed >= 120 km/h is treated as an air leg;
the nearest IATA airports to its endpoints are attached.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from .. import airports
from ..config import get_settings
from ..geo import bearing_delta_deg, haversine_km, initial_bearing_deg, parse_coord, valid_lat_lon

FAST_SHORT_HOP_SPEED = 300.0   # km/h
FAST_SHORT_HOP_DIST = 80.0     # km
BOUNCE_SPEED = 200.0           # km/h
BOUNCE_ANGLE = 150.0           # deg (~reversal)
FLIGHT_MIN_GAP_MIN = 25.0
FLIGHT_MIN_DIST_KM = 150.0
FLIGHT_MIN_SPEED = 120.0
AIRPORT_SEARCH_KM = 120.0


@dataclass
class Ping:
    idx: int
    lat: Optional[float]
    lon: Optional[float]
    ts: Optional[datetime]
    raw: dict
    speed_kmh: Optional[float] = None
    bearing: Optional[float] = None
    dist_km: Optional[float] = None
    gap_min: Optional[float] = None
    ghost: bool = False
    reasons: list = field(default_factory=list)


def _to_dt(v) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def analyze_pings(rows: list[dict]) -> dict:
    """rows: sensitech_inbound_trip rows, any order. Returns pings with ghost
    flags, inferred flight segments, and summary stats."""
    s = get_settings()
    pings: list[Ping] = []
    for i, r in enumerate(rows):
        lat = parse_coord(r.get("latitude"))
        lon = parse_coord(r.get("longitude"))
        ts = _to_dt(r.get("device_date_time")) or _to_dt(r.get("device_ping_date_time"))
        pings.append(Ping(idx=i, lat=lat, lon=lon, ts=ts, raw=r))

    # sort by time; undated pings sink to the end and are flagged
    dated = sorted([p for p in pings if p.ts is not None], key=lambda p: p.ts)
    undated = [p for p in pings if p.ts is None]
    for p in undated:
        p.ghost = True
        p.reasons.append("missing_timestamp")

    for p in dated:
        if not valid_lat_lon(p.lat, p.lon):
            p.ghost = True
            p.reasons.append("invalid_coords")

    clean_prev: Optional[Ping] = None
    for p in dated:
        if "invalid_coords" in p.reasons:
            continue
        if clean_prev is not None:
            d = haversine_km(clean_prev.lat, clean_prev.lon, p.lat, p.lon)
            dt_s = (p.ts - clean_prev.ts).total_seconds()
            p.dist_km = round(d, 3)
            p.gap_min = round(dt_s / 60.0, 2)
            p.bearing = round(initial_bearing_deg(clean_prev.lat, clean_prev.lon, p.lat, p.lon), 1)
            if dt_s <= 0:
                if d > 1.0:
                    p.ghost = True
                    p.reasons.append("time_conflict")
                clean_prev = p if not p.ghost else clean_prev
                continue
            speed = d / dt_s * 3600.0
            p.speed_kmh = round(speed, 1)
            if speed > s.ghost_max_speed_kmh:
                p.ghost = True
                p.reasons.append("teleport")
            elif speed > FAST_SHORT_HOP_SPEED and d < FAST_SHORT_HOP_DIST:
                p.ghost = True
                p.reasons.append("short_hop")
        if not p.ghost:
            clean_prev = p

    # bounce detection over the clean, dated sequence
    seq = [p for p in dated if not p.ghost and valid_lat_lon(p.lat, p.lon)]
    for a, b, c in zip(seq, seq[1:], seq[2:]):
        if b.speed_kmh is None or c.speed_kmh is None or b.bearing is None or c.bearing is None:
            continue
        if (
            b.speed_kmh > BOUNCE_SPEED
            and c.speed_kmh > BOUNCE_SPEED
            and bearing_delta_deg(b.bearing, c.bearing) > BOUNCE_ANGLE
            and haversine_km(a.lat, a.lon, c.lat, c.lon) < max(2.0, 0.2 * (b.dist_km or 0))
        ):
            b.ghost = True
            b.reasons.append("bounce")

    # flight segments from the final clean sequence
    seq = [p for p in dated if not p.ghost and valid_lat_lon(p.lat, p.lon)]
    segments = []
    for prev, cur in zip(seq, seq[1:]):
        dt_min = (cur.ts - prev.ts).total_seconds() / 60.0
        d = haversine_km(prev.lat, prev.lon, cur.lat, cur.lon)
        speed = d / (dt_min / 60.0) if dt_min > 0 else 0.0
        if dt_min >= FLIGHT_MIN_GAP_MIN and d >= FLIGHT_MIN_DIST_KM and speed >= FLIGHT_MIN_SPEED:
            dep = airports.nearest(prev.lat, prev.lon, AIRPORT_SEARCH_KM)
            arr = airports.nearest(cur.lat, cur.lon, AIRPORT_SEARCH_KM)
            segments.append({
                "from": {"lat": prev.lat, "lon": prev.lon, "ts": prev.ts.isoformat()},
                "to": {"lat": cur.lat, "lon": cur.lon, "ts": cur.ts.isoformat()},
                "distance_km": round(d, 1),
                "gap_minutes": round(dt_min, 1),
                "implied_speed_kmh": round(speed, 1),
                "departure_airport": dep,
                "arrival_airport": arr,
                "source": "inferred_from_ping_gap",
            })

    out_pings = []
    for p in sorted(pings, key=lambda p: (p.ts is None, p.ts or datetime.min)):
        out_pings.append({
            "lat": p.lat,
            "lon": p.lon,
            "ts": p.ts.isoformat() if p.ts else None,
            "speed_kmh": p.speed_kmh,
            "bearing": p.bearing,
            "dist_km": p.dist_km,
            "gap_min": p.gap_min,
            "ghost": p.ghost,
            "reasons": p.reasons,
            "address": p.raw.get("current_address"),
            "device": p.raw.get("deviceserialnumber"),
            "tripid": p.raw.get("tripid"),
        })

    ghosts = [p for p in out_pings if p["ghost"]]
    return {
        "pings": out_pings,
        "flight_segments": segments,
        "summary": {
            "total_pings": len(out_pings),
            "ghost_pings": len(ghosts),
            "ghost_reasons": _count_reasons(ghosts),
            "first_ping": out_pings[0]["ts"] if out_pings else None,
            "last_ping": next((p["ts"] for p in reversed(out_pings) if p["ts"]), None),
            "devices": sorted({p["device"] for p in out_pings if p["device"]}),
        },
    }


def _count_reasons(ghosts: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for g in ghosts:
        for r in g["reasons"]:
            counts[r] = counts.get(r, 0) + 1
    return counts
