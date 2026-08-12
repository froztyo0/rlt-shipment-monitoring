"""Carrier ETA Calibration — bias-corrected delivery forecast.

Carrier analytics report an aggregate on-time %, but nobody uses history to
CORRECT an individual live ETA. RLT doses have a hard injection deadline, so a
carrier that is systematically (say) a day optimistic quietly turns 'on-track'
doses into missed ones. This learns each carrier's own delivery bias and its
spread from delivered history, adds that bias to live ETAs, and re-checks the
injection deadline / vial expiry — flipping 'on-track (raw)' into
'at-risk (calibrated)'. Pure median-bias + MAD spread; no ML.

Read-only, bounded (recent delivered history + the active injection window),
set-based. Uses etl.shipment only; if etl.shipment_history exists it could
sharpen the 'earliest committed ETA', but we never depend on it.
"""
import re
import statistics
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query

from ..cache import cached
from ..db import fetch_all
from ..analysis import quality as q

router = APIRouter(prefix="/api/eta-calibration", tags=["eta-calibration"])

MIN_SAMPLES = 3          # below this we don't trust a carrier's bias
ONTIME_TOL_H = 6.0       # within 6h of committed = "on time"
LATE_H = 24.0            # more than a day late = "very late"


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


def _combine(date_v, time_v) -> Optional[tuple[datetime, bool]]:
    """Combine a date column with a 'HH:MM AM/PM' text time column.
    Returns (datetime, has_explicit_time). When no time is known we return the
    date at midnight and has_time=False, so callers can fall back to day-level
    slippage rather than inventing a time-of-day that biases the error."""
    d = _naive_dt(date_v)
    if not d:
        m = re.match(r"\s*(\d{4})-(\d{1,2})-(\d{1,2})", str(date_v or ""))
        if not m:
            return None
        d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    base = d.replace(hour=0, minute=0, second=0, microsecond=0)
    m = re.search(r"(\d{1,2}):(\d{2})\s*([AaPp][Mm])?", str(time_v or ""))
    if m:
        h, mn, ap = int(m.group(1)), int(m.group(2)), (m.group(3) or "").upper()
        if ap == "PM" and h < 12:
            h += 12
        elif ap == "AM" and h == 12:
            h = 0
        if 0 <= h <= 23:
            return (base.replace(hour=h, minute=mn), True)
    if d.hour or d.minute:          # the date value itself carried a real time
        return (d, True)
    return (base, False)


def _committed(eta, planned_date, planned_time) -> Optional[tuple[datetime, bool]]:
    """Best 'promised delivery': the live ETA (precise) if present, else the
    planned delivery datetime (precise only if a time is recorded)."""
    e = _naive_dt(eta)
    if e:
        return (e, True)
    return _combine(planned_date, planned_time)


def _error_hours(actual: datetime, committed: datetime, precise: bool) -> float:
    """Delivery error vs the promise. Precise (real times) → hours; otherwise
    day-level slippage in hours, so an unknown time-of-day can't fake a bias."""
    if precise:
        return (actual - committed).total_seconds() / 3600.0
    return (actual.date() - committed.date()).days * 24.0


def _deadline_dt(date_v, time_v) -> Optional[datetime]:
    c = _combine(date_v, time_v)
    return c[0] if c else None


def _key(carrier, mode) -> tuple[str, str]:
    return (str(carrier or "").strip(), str(mode or "").strip() or "—")


@router.get("")
async def eta_calibration(
    history_days: int = Query(default=180, ge=14, le=730),
    days_back: int = Query(default=3, ge=0, le=30),
    days_fwd: int = Query(default=21, ge=1, le=90),
):
    return await cached(
        f"etacal:{history_days}:{days_back}:{days_fwd}", 120,
        lambda: _compute(history_days, days_back, days_fwd),
    )


async def _compute(history_days: int, days_back: int, days_fwd: int):
    # ---- backward pass: learn each carrier's delivery bias from history ----
    delivered = await fetch_all(f"""
        SELECT s.carrier, s.modeoftransportation AS mode, s.region,
               s.destinationcountry, s.planneddeliverydate, s.planneddeliverytime,
               s.etadeliverytime, s.actualdeliverytime
        FROM etl.shipment s
        WHERE {q.DELIVERED_SQL}
          AND NULLIF(btrim(s.carrier::text), '') IS NOT NULL
          AND s.actualdeliverytime::text ~ '^\\s*\\d{{4}}-\\d{{2}}-\\d{{2}}'
          AND s.actualdeliverytime::timestamp >= now() - make_interval(days => {int(history_days)})
        LIMIT 8000
    """)

    errs: dict[tuple[str, str], list[float]] = {}
    lanes: dict[tuple[str, str], set] = {}
    for r in delivered:
        actual = _naive_dt(r["actualdeliverytime"])
        committed = _committed(r["etadeliverytime"], r["planneddeliverydate"], r["planneddeliverytime"])
        if not actual or not committed:
            continue
        k = _key(r["carrier"], r["mode"])
        errs.setdefault(k, []).append(_error_hours(actual, committed[0], committed[1]))
        lane = str(r["region"] or r["destinationcountry"] or "").strip()
        if lane:
            lanes.setdefault(k, set()).add(lane)

    stats: dict[tuple[str, str], dict] = {}
    carriers = []
    for k, e in errs.items():
        e_sorted = sorted(e)
        n = len(e_sorted)
        median = statistics.median(e_sorted)
        mad = statistics.median([abs(x - median) for x in e_sorted]) if n > 1 else 0.0
        p90 = e_sorted[min(n - 1, int(round(0.9 * (n - 1))))]
        on_time = sum(1 for x in e_sorted if abs(x) <= ONTIME_TOL_H) / n
        very_late = sum(1 for x in e_sorted if x > LATE_H) / n
        st = {
            "carrier": k[0], "mode": k[1], "n": n,
            "median_bias_h": round(median, 1), "spread_mad_h": round(mad, 1),
            "p90_bias_h": round(p90, 1),
            "on_time_pct": round(100 * on_time, 0), "very_late_pct": round(100 * very_late, 0),
            "lanes": sorted(lanes.get(k, set()))[:6],
            "trusted": n >= MIN_SAMPLES,
        }
        stats[k] = st
        carriers.append(st)
    # worst (most optimistic / late) first, trusted before thin-sample
    carriers.sort(key=lambda s: (s["trusted"], s["median_bias_h"]), reverse=True)

    # ---- forward pass: correct live ETAs, re-check the deadline ----
    active = await fetch_all(f"""
        SELECT s.salesordernumber, s.trackingnumber, s.product, s.carrier,
               s.modeoftransportation AS mode, s.region, s.injectiondate,
               s.injectiontime, s.etadeliverytime, s.planneddeliverydate,
               s.planneddeliverytime, s.vialexpirationtime, s.currentmilestone
        FROM etl.shipment s
        WHERE {q.ACTIVE_SQL}
          AND NULLIF(btrim(s.carrier::text), '') IS NOT NULL
          AND s.injectiondate::text ~ '^\\s*\\d{{4}}-\\d{{2}}-\\d{{2}}'
          AND s.injectiondate::date BETWEEN CURRENT_DATE - {int(days_back)}
                                        AND CURRENT_DATE + {int(days_fwd)}
        ORDER BY s.injectiondate::date ASC
        LIMIT 800
    """)

    live = []
    flipped = tightened = uncalibrated = 0
    for r in active:
        committed_t = _committed(r["etadeliverytime"], r["planneddeliverydate"], r["planneddeliverytime"])
        committed = committed_t[0] if committed_t else None
        deadline = _deadline_dt(r["injectiondate"], r["injectiontime"])
        vial = _naive_dt(r["vialexpirationtime"])
        k = _key(r["carrier"], r["mode"])
        st = stats.get(k)
        bias = st["median_bias_h"] if (st and st["trusted"]) else None
        spread = st["spread_mad_h"] if (st and st["trusted"]) else None

        calibrated = committed + timedelta(hours=bias) if (committed and bias is not None) else None
        slack_raw = round((deadline - committed).total_seconds() / 3600.0, 1) if (deadline and committed) else None
        slack_cal = round((deadline - calibrated).total_seconds() / 3600.0, 1) if (deadline and calibrated) else None
        miss_vial = bool(vial and calibrated and calibrated > vial)

        if bias is None:
            verdict = "uncalibrated"
            uncalibrated += 1
        elif (slack_cal is not None and slack_cal < 0) or miss_vial:
            verdict = "will_miss_calibrated"
        elif slack_cal is not None and slack_cal < 12:
            verdict = "tight_calibrated"
        else:
            verdict = "on_track"

        is_flipped = (slack_raw is not None and slack_raw >= 0
                      and slack_cal is not None and slack_cal < 0)
        if is_flipped:
            flipped += 1
        elif verdict == "tight_calibrated" and (slack_raw is None or slack_raw >= 12):
            tightened += 1

        live.append({
            "salesordernumber": r["salesordernumber"], "trackingnumber": r["trackingnumber"],
            "product": r["product"], "carrier": r["carrier"], "mode": r["mode"],
            "currentmilestone": r["currentmilestone"],
            "injection_deadline": deadline.isoformat() + "Z" if deadline else None,
            "committed_eta": committed.isoformat() + "Z" if committed else None,
            "calibrated_eta": calibrated.isoformat() + "Z" if calibrated else None,
            "bias_h": bias, "spread_h": spread,
            "slack_raw_h": slack_raw, "slack_calibrated_h": slack_cal,
            "miss_vial": miss_vial, "verdict": verdict, "flipped": is_flipped,
        })

    rank = {"will_miss_calibrated": 0, "tight_calibrated": 1, "on_track": 2, "uncalibrated": 3}
    live.sort(key=lambda x: (0 if x["flipped"] else 1, rank.get(x["verdict"], 9),
                             x["slack_calibrated_h"] if x["slack_calibrated_h"] is not None else 1e9))

    return {
        "params": {"history_days": history_days, "days_back": days_back, "days_fwd": days_fwd,
                   "min_samples": MIN_SAMPLES},
        "summary": {
            "carriers_profiled": len([c for c in carriers if c["trusted"]]),
            "live_checked": len(live),
            "flipped": flipped, "tightened": tightened, "uncalibrated": uncalibrated,
            "will_miss": sum(1 for x in live if x["verdict"] == "will_miss_calibrated"),
        },
        "carriers": carriers,
        "live": live,
    }
