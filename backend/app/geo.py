"""Geodesic helpers: haversine distance, initial bearing, bearing delta."""
import math
from typing import Optional

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def initial_bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    x = math.sin(dlmb) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlmb)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def bearing_delta_deg(b1: float, b2: float) -> float:
    """Smallest absolute angle between two bearings (0..180)."""
    d = abs(b1 - b2) % 360.0
    return 360.0 - d if d > 180.0 else d


def parse_coord(value) -> Optional[float]:
    """Coerce a lat/lon value that may arrive as text/Decimal/None."""
    if value is None:
        return None
    try:
        f = float(str(value).strip())
    except (ValueError, TypeError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def valid_lat_lon(lat: Optional[float], lon: Optional[float]) -> bool:
    if lat is None or lon is None:
        return False
    if abs(lat) > 90 or abs(lon) > 180:
        return False
    # (0,0) is the classic null-island ghost
    if abs(lat) < 1e-6 and abs(lon) < 1e-6:
        return False
    return True
