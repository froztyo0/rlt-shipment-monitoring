"""Radioactive decay / dose intelligence — deterministic physics, no ML.

RLT doses carry a radioisotope (Lutetium-177 for Pluvicto & Lutathera) whose
activity falls continuously: A(t) = A0 * 2^(-(t - t0)/half_life). The vial is
calibrated so the *prescribed* activity lands at the scheduled injection time,
so a dose delivered/injected after that time is under-activity ("underdosed")
and past a tolerance is clinically unusable. All inputs come from columns that
already exist on etl.threeagesttwo_batches_inbound (mbq / gbq / mci /
planned_activity / planned_mbq / tinj_datetime / texp) — no schema/data change.
"""
import math
from datetime import datetime, timedelta
from typing import Optional

# isotope -> half-life in hours
HALF_LIFE_HOURS = {
    "Lu-177": 6.647 * 24,   # 159.53 h — lutetium-177 (Pluvicto, Lutathera)
    "Ac-225": 9.92 * 24,    # actinium-225
    "I-131": 8.02 * 24,
    "Y-90": 64.1,
    "Ga-68": 1.13,
    "F-18": 1.83,
}

# product name (lowercased, substring) -> isotope
PRODUCT_ISOTOPE = [
    ("pluvicto", "Lu-177"),
    ("lutathera", "Lu-177"),
    ("lutetium", "Lu-177"),
    ("lu-177", "Lu-177"),
    ("lu177", "Lu-177"),
    ("actinium", "Ac-225"),
    ("ac-225", "Ac-225"),
]

# clinically usable activity band around the prescribed activity (fraction)
DEFAULT_TOLERANCE = 0.10  # ±10%


def isotope_for_product(product: Optional[str]) -> str:
    p = (product or "").strip().lower()
    for needle, iso in PRODUCT_ISOTOPE:
        if needle in p:
            return iso
    return "Lu-177"  # RLT default — both marketed RLT drugs are Lu-177


def half_life_hours(isotope: str) -> float:
    return HALF_LIFE_HOURS.get(isotope, HALF_LIFE_HOURS["Lu-177"])


def activity_at(a0: float, t0: datetime, t: datetime, hl_hours: float) -> float:
    """Activity at time t given activity a0 at reference time t0."""
    dt_h = (t - t0).total_seconds() / 3600.0
    return a0 * math.pow(2.0, -dt_h / hl_hours)


def hours_to_fraction(hl_hours: float, fraction: float) -> float:
    """Hours for activity to fall TO `fraction` of its value (0<fraction<=1)."""
    if fraction <= 0 or fraction >= 1:
        return 0.0
    return hl_hours * math.log2(1.0 / fraction)


def as_mbq(mbq=None, gbq=None, mci=None) -> Optional[float]:
    """Best available activity in MBq. 1 GBq = 1000 MBq; 1 mCi = 37 MBq."""
    for v in (mbq,):
        f = _num(v)
        if f:
            return f
    f = _num(gbq)
    if f:
        return f * 1000.0
    f = _num(mci)
    if f:
        return f * 37.0
    return None


def fmt_gbq(mbq: Optional[float]) -> Optional[float]:
    return round(mbq / 1000.0, 3) if mbq is not None else None


def fmt_mci(mbq: Optional[float]) -> Optional[float]:
    return round(mbq / 37.0, 1) if mbq is not None else None


def _num(v) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(str(v).strip())
    except (ValueError, TypeError):
        return None
    return f if (not math.isnan(f) and not math.isinf(f) and f > 0) else None


def build_curve(a0: float, t0: datetime, hl_hours: float,
                start: datetime, end: datetime, points: int = 60) -> list[dict]:
    """Sampled A(t) between start and end for the chart."""
    if end <= start:
        end = start + timedelta(hours=1)
    total = (end - start).total_seconds()
    out = []
    for i in range(points + 1):
        t = start + timedelta(seconds=total * i / points)
        out.append({"t": t.isoformat(), "mbq": round(activity_at(a0, t0, t, hl_hours), 1)})
    return out
