"""Airport reference data from https://github.com/datasets/airport-codes.

Loaded once at startup from backend/data/airport-codes.csv (auto-downloaded
if missing). Only rows with an IATA code are kept. Lookups:
  - by_iata(code)          -> airport dict
  - nearest(lat, lon, ...) -> nearest IATA airport within a radius
Nearest search is a brute-force scan over ~5-6k IATA airports with a cheap
bounding-box prefilter — microseconds per call, no extra dependencies.
"""
import csv
import logging
import math
import threading
from pathlib import Path
from typing import Optional

from .config import DATA_DIR, get_settings
from .geo import haversine_km

log = logging.getLogger(__name__)

CSV_PATH = DATA_DIR / "airport-codes.csv"

_lock = threading.Lock()
_airports: list[dict] = []
_by_iata: dict[str, dict] = {}
_loaded = False

# Rank airports so "nearest" prefers real passenger airports over heliports.
_TYPE_RANK = {"large_airport": 0, "medium_airport": 1, "small_airport": 2}


def _download() -> bool:
    import httpx

    s = get_settings()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for url in (s.airports_csv_url, s.airports_csv_url_fallback):
        try:
            with httpx.Client(timeout=60, follow_redirects=True) as client:
                r = client.get(url)
                r.raise_for_status()
                CSV_PATH.write_bytes(r.content)
                log.info("Downloaded airport codes from %s (%d bytes)", url, len(r.content))
                return True
        except Exception as e:  # noqa: BLE001
            log.warning("Airport CSV download failed from %s: %s", url, e)
    return False


def _parse_coords(raw: str) -> Optional[tuple[float, float]]:
    """The dataset's `coordinates` column is '<lat>, <lon>' — verified against
    known airports. Defensive swap: if the first number is out of latitude
    range it must be the longitude."""
    try:
        a_str, b_str = raw.split(",")
        a, b = float(a_str), float(b_str)
    except (ValueError, AttributeError):
        return None
    lat, lon = a, b
    if abs(lat) > 90 and abs(lon) <= 90:
        lat, lon = lon, lat
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    return lat, lon


def load(force: bool = False) -> int:
    global _loaded
    with _lock:
        if _loaded and not force:
            return len(_airports)
        if not CSV_PATH.exists():
            if not _download():
                log.error("No airport data available; airport plotting disabled.")
                _loaded = True
                return 0
        _airports.clear()
        _by_iata.clear()
        with CSV_PATH.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                iata = (row.get("iata_code") or "").strip().upper()
                if not iata or len(iata) != 3:
                    continue
                typ = (row.get("type") or "").strip()
                if typ == "closed":
                    continue
                # coordinates may be one column or split lat/lon depending on revision
                coords = None
                if row.get("coordinates"):
                    coords = _parse_coords(row["coordinates"])
                elif row.get("latitude_deg") and row.get("longitude_deg"):
                    try:
                        coords = (float(row["latitude_deg"]), float(row["longitude_deg"]))
                    except ValueError:
                        coords = None
                if not coords:
                    continue
                ap = {
                    "iata": iata,
                    "name": (row.get("name") or "").strip(),
                    "type": typ,
                    "municipality": (row.get("municipality") or "").strip(),
                    "iso_country": (row.get("iso_country") or "").strip(),
                    "lat": coords[0],
                    "lon": coords[1],
                }
                _airports.append(ap)
                # Prefer larger airports when an IATA code appears twice
                prev = _by_iata.get(iata)
                if prev is None or _TYPE_RANK.get(typ, 9) < _TYPE_RANK.get(prev["type"], 9):
                    _by_iata[iata] = ap
        _loaded = True
        log.info("Loaded %d IATA airports", len(_airports))
        return len(_airports)


def by_iata(code: Optional[str]) -> Optional[dict]:
    if not code:
        return None
    if not _loaded:
        load()
    return _by_iata.get(code.strip().upper())


def nearest(lat: float, lon: float, max_km: float = 120.0,
            min_rank: str = "medium_airport") -> Optional[dict]:
    """Nearest IATA airport within max_km. Prefers large/medium airports;
    falls back to any IATA airport if none of those are in range."""
    if not _loaded:
        load()
    if not _airports:
        return None
    max_rank = _TYPE_RANK.get(min_rank, 1)
    # bounding-box prefilter: 1 deg lat ~ 111 km
    dlat = max_km / 111.0
    dlon = max_km / max(1e-6, 111.0 * math.cos(math.radians(min(89.0, abs(lat)))))

    best, best_d = None, None
    fallback, fallback_d = None, None
    for ap in _airports:
        if abs(ap["lat"] - lat) > dlat or abs(ap["lon"] - lon) > dlon:
            continue
        d = haversine_km(lat, lon, ap["lat"], ap["lon"])
        if d > max_km:
            continue
        if _TYPE_RANK.get(ap["type"], 9) <= max_rank:
            if best_d is None or d < best_d:
                best, best_d = ap, d
        elif fallback_d is None or d < fallback_d:
            fallback, fallback_d = ap, d
    hit, dist = (best, best_d) if best else (fallback, fallback_d)
    if not hit:
        return None
    return {**hit, "distance_km": round(dist, 1)}
