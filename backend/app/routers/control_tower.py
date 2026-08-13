"""Control Tower — one fast, cached endpoint that powers the whole command page.

Everything the 9 tower sections need is computed from a SINGLE bounded scan of
etl.shipment (the injection window, ±30d) plus a handful of tiny feed-recency
queries, aggregated in Python. One request → the page renders instantly.
Read-only, bounded, cached.
"""
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter

from ..cache import cached
from ..config import get_settings
from ..db import fetch_all, fetch_one
from ..analysis import quality as q

router = APIRouter(prefix="/api/control-tower", tags=["control-tower"])

_RISK_HI = ("s.risk ILIKE '%high%' OR s.risk ILIKE '%critical%' "
            "OR s.riskbucket ILIKE '%high%' OR s.riskbucket ILIKE '%critical%'")

# feed -> (display, table, silent-after hours)
FEEDS = [
    ("Sensitech GPS", "sensitech_inbound_trip", 6),
    ("Carrier events", "carrier_inbound", 12),
    ("ROME orders", "rome_inbound_orders", 24),
    ("3A GEST2 batches", "threeagesttwo_batches_inbound", 24),
]


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
async def control_tower():
    return await cached("control-tower", 60, _compute)


async def _compute():
    s = get_settings()
    gps_h = s.gps_stale_hours
    rows = await fetch_all(f"""
        SELECT s.salesordernumber, s.trackingnumber, s.product, s.carrier, s.region,
               s.origin, s.destinationname, s.destinationlatitude, s.destinationlongitude,
               s.injectiondate, s.injectiontime, s.currentmilestone, s.dosestatus,
               s.risk, s.riskbucket, s.etadeliverytime, s.planneddeliverydate,
               s.actualdeliverytime, s.actualdeparted, s.vialexpirationtime,
               s.lastgps, s.batchnumber, s.countofalerts, s.lastupdateddt,
               {q.DELIVERED_SQL} AS is_delivered,
               {q.CANCELLED_SQL} AS is_cancelled,
               COALESCE({_RISK_HI}, FALSE) AS hi_risk
        FROM etl.shipment s
        WHERE s.injectiondate::text ~ '^\\s*\\d{{4}}-\\d{{2}}-\\d{{2}}'
          AND s.injectiondate::date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE + 30
        ORDER BY s.injectiondate::date ASC
        LIMIT 2000
    """)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today = now.date()

    fleet = {"active": 0, "in_transit": 0, "at_risk": 0, "overdue": 0,
             "delivered_today": 0, "doses_at_risk": 0}
    queue = []
    exc: dict[str, list] = {}
    cal: dict[str, dict] = {}
    carriers: dict[str, dict] = {}
    conc: dict[str, dict] = {"carrier": {}, "region": {}, "origin": {}}
    otif_ok = otif_tot = integ_ok = integ_tot = 0
    changed = []

    def add_exc(code, item):
        exc.setdefault(code, []).append(item)

    for r in rows:
        delivered = bool(r["is_delivered"])
        cancelled = bool(r["is_cancelled"])
        active = not delivered and not cancelled
        departed = bool(str(r["actualdeparted"] or "").strip())
        inj = _deadline(r["injectiondate"], r["injectiontime"])
        eta = _naive_dt(r["etadeliverytime"])
        gps = _naive_dt(r["lastgps"])
        gps_stale = departed and (gps is None or (now - gps).total_seconds() > gps_h * 3600)
        carrier = str(r["carrier"] or "").strip() or "(unassigned)"

        # calendar (all injection-dated rows)
        d = str(_naive_dt(r["injectiondate"]).date()) if _naive_dt(r["injectiondate"]) else None
        if d:
            c = cal.setdefault(d, {"day": d, "total": 0, "at_risk": 0, "overdue": 0})
            c["total"] += 1
            if active and inj and inj.date() < today:
                c["overdue"] += 1
            elif active and r["hi_risk"]:
                c["at_risk"] += 1

        # OTIF + dose-integrity proxy (delivered set)
        if delivered:
            otif_tot += 1
            adt = _naive_dt(r["actualdeliverytime"])
            pdt = _naive_dt(r["planneddeliverydate"])
            if adt and pdt and adt.date() <= pdt.date():
                otif_ok += 1
            if inj:
                integ_tot += 1
                if adt and adt <= inj:          # arrived before injection = dose still usable window
                    integ_ok += 1
            if adt and adt.date() == today:
                fleet["delivered_today"] += 1

        if not active:
            continue

        fleet["active"] += 1
        if departed:
            fleet["in_transit"] += 1
        for grain, key in (("carrier", carrier), ("region", str(r["region"] or "").strip()),
                           ("origin", str(r["origin"] or "").strip())):
            if key:
                conc[grain][key] = conc[grain].get(key, 0) + 1
        cs = carriers.setdefault(carrier, {"carrier": carrier, "active": 0, "overdue": 0,
                                           "at_risk": 0, "gps_lost": 0})
        cs["active"] += 1

        # per-dose urgency score + reasons + recommended play
        score, reasons, play = 0, [], None
        overdue = inj is not None and inj.date() < today
        inj_h = (inj - now).total_seconds() / 3600.0 if inj else None
        if overdue:
            score += 1000 + min(500, abs(inj_h or 0))
            reasons.append("injection deadline passed")
            play = "Confirm delivery/injection with the site; if undelivered, escalate to carrier ops."
            fleet["overdue"] += 1
            cs["overdue"] += 1
            add_exc("overdue", _mini(r, "injection passed"))
        elif inj_h is not None and inj_h <= 24 and not delivered:
            score += 500 + (24 - inj_h) * 8
            reasons.append(f"injects in {inj_h:.0f}h")
            play = play or "Expedite; re-confirm the carrier ETA and lock the delivery slot."
        elif inj_h is not None and inj_h <= 72:
            score += 180
            reasons.append(f"injects in {inj_h/24:.1f}d")
        if r["hi_risk"]:
            score += 300
            reasons.append("high/critical risk")
            cs["at_risk"] += 1
            add_exc("high_risk", _mini(r, str(r["riskbucket"] or r["risk"] or "high risk")))
        if gps_stale:
            score += 150
            reasons.append("GPS silent")
            play = play or "Chase the carrier for a location update — GPS has gone dark."
            cs["gps_lost"] += 1
            add_exc("gps_lost", _mini(r, "no recent GPS"))
        if active and not departed and inj_h is not None and inj_h <= 72:
            score += 200
            reasons.append("not yet departed")
            play = play or "Confirm pickup — the dose has not departed and injects soon."
            add_exc("not_departed", _mini(r, "awaiting departure"))
        if active and departed and not eta:
            score += 60
            reasons.append("no carrier ETA")
            add_exc("no_eta", _mini(r, "ETA missing"))
        if not str(r["batchnumber"] or "").strip():
            add_exc("missing_batch", _mini(r, "no batch on shipment"))

        if r["hi_risk"] or overdue or (inj_h is not None and inj_h <= 72):
            fleet["at_risk"] += 1
            fleet["doses_at_risk"] += 1

        lu = _naive_dt(r["lastupdateddt"])
        if lu and (now - lu).total_seconds() <= 12 * 3600:
            changed.append(_mini(r, r["currentmilestone"]))

        if score > 0:
            queue.append({
                **_mini(r, None),
                "score": round(score),
                "injection_deadline": inj.isoformat() + "Z" if inj else None,
                "eta": eta.isoformat() + "Z" if eta else None,
                "slack_h": round((inj - eta).total_seconds() / 3600.0, 1) if (inj and eta) else None,
                "reasons": reasons,
                "play": play or "Monitor.",
            })

    queue.sort(key=lambda x: -x["score"])

    # feeds — tiny recency queries
    feeds = []
    for label, table, thr in FEEDS:
        try:
            row = await fetch_one(f"SELECT MAX(audit_timestamp) AS last FROM etl.{table}")
            last = _naive_dt(row["last"]) if row else None
            age = (now - last).total_seconds() / 3600.0 if last else None
            feeds.append({
                "feed": label,
                "last": last.isoformat() + "Z" if last else None,
                "age_h": round(age, 1) if age is not None else None,
                "silent": age is None or age > thr,
                "threshold_h": thr,
            })
        except Exception:  # noqa: BLE001
            feeds.append({"feed": label, "last": None, "age_h": None, "silent": True, "threshold_h": thr})

    def top(grain):
        d = conc[grain]
        tot = sum(d.values()) or 1
        items = sorted(d.items(), key=lambda kv: -kv[1])[:5]
        hhi = round(sum((v / tot) ** 2 for v in d.values()), 2)
        return {"nodes": [{"name": k, "value": v, "pct": round(100 * v / tot)} for k, v in items],
                "hhi": hhi, "top_pct": round(100 * items[0][1] / tot) if items else 0}

    carrier_list = sorted(carriers.values(), key=lambda c: (-c["overdue"], -c["active"]))

    return {
        "generated_at": now.isoformat() + "Z",
        "fleet": fleet,
        "action_queue": queue[:20],
        "exceptions": [
            {"code": k, "count": len(v), "items": v[:8]} for k, v in
            sorted(exc.items(), key=lambda kv: -len(kv[1]))
        ],
        "sla": {
            "otif_pct": round(100 * otif_ok / otif_tot) if otif_tot else None,
            "otif_n": otif_tot,
            "dose_integrity_pct": round(100 * integ_ok / integ_tot) if integ_tot else None,
            "dose_integrity_n": integ_tot,
        },
        "carriers": carrier_list,
        "concentration": {"carrier": top("carrier"), "region": top("region"), "origin": top("origin")},
        "calendar": [cal[k] for k in sorted(cal.keys())],
        "feeds": feeds,
        "changed_12h": changed[:12],
        "map_points": [
            {"so": qi["salesordernumber"], "tn": qi["trackingnumber"], "lat": qi["lat"],
             "lon": qi["lon"], "score": qi["score"], "carrier": qi["carrier"]}
            for qi in queue if qi.get("lat") is not None
        ][:60],
    }


def _mini(r, note) -> dict:
    from ..geo import parse_coord
    return {
        "salesordernumber": r["salesordernumber"], "trackingnumber": r["trackingnumber"],
        "product": r["product"], "carrier": str(r["carrier"] or "").strip() or "(unassigned)",
        "region": r["region"], "destinationname": r["destinationname"],
        "currentmilestone": r["currentmilestone"], "injectiondate": r["injectiondate"],
        "risk": r["riskbucket"] or r["risk"], "note": note,
        "lat": parse_coord(r["destinationlatitude"]), "lon": parse_coord(r["destinationlongitude"]),
    }
