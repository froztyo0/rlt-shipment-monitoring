"""Batch Cohort Blast-Radius.

RLT's true unit of failure is the production LOT, not the parcel. One Lu-177
bulk batch is split into per-patient vials from a single, un-reproducible,
decay-synchronised run — so a batch hold, recall, or shared-carrier delay
strands EVERY un-injected patient in that lot at once. Shipment-centric views
show N independent alerts; this groups them by batch and answers the real
question: "how many patients would one bad lot strand?" — turning N parcel
alerts into "M patients at risk from lot X".

Read-only, bounded (a windowed shipment set), set-based (group in Python over
one bounded scan, plus one optional batch-status enrichment query). No writes,
no schema change; the batch enrichment is schema-adaptive.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Query

from ..cache import cached
from ..db import fetch_all
from ..analysis import quality as q

router = APIRouter(prefix="/api/cohorts", tags=["cohorts"])

_RISK_RANK = {"critical": 4, "high": 4, "serious": 3, "medium": 2, "med": 2, "warning": 2, "low": 1}
_LEVEL_ORDER = {"overdue": 0, "imminent": 1, "upcoming": 2, "done": 3}


def _naive_dt(v) -> Optional[datetime]:
    """Parse to naive-UTC (asyncpg timestamptz is tz-aware UTC; text columns may
    carry any offset). Same convention as the dose endpoint."""
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


def _max_risk(members: list[dict]) -> Optional[str]:
    best, label = 0, None
    for m in members:
        rank = _RISK_RANK.get(str(m.get("risk") or "").strip().lower(), 0)
        if rank > best:
            best, label = rank, m.get("risk")
    return label


async def _batch_columns() -> set[str]:
    rows = await fetch_all(
        """SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'etl' AND table_name = 'threeagesttwo_batches_inbound'"""
    )
    return {str(r["column_name"]).lower() for r in rows}


@router.get("")
async def batch_cohorts(
    days_back: int = Query(default=7, ge=0, le=60),
    days_fwd: int = Query(default=28, ge=1, le=120),
    limit: int = Query(default=800, ge=1, le=2000),
):
    """Production lots ranked by patient blast-radius (un-injected doses that one
    lot problem would strand at once)."""
    return await cached(
        f"cohorts:{days_back}:{days_fwd}:{limit}", 90,
        lambda: _compute(days_back, days_fwd, limit),
    )


async def _compute(days_back: int, days_fwd: int, limit: int):
    rows = await fetch_all(f"""
        SELECT s.batchnumber, s.salesordernumber, s.trackingnumber, s.product,
               s.production_site, s.destinationname, s.destinationcountry,
               s.carrier, s.region, s.injectiondate, s.injectiontime,
               s.dosestatus, s.currentmilestone, s.risk, s.riskbucket,
               s.vialexpirationtime, s.etadeliverytime, s.actualdeliverytime,
               {q.DELIVERED_SQL} AS is_delivered,
               {q.CANCELLED_SQL} AS is_cancelled
        FROM etl.shipment s
        WHERE NULLIF(btrim(s.batchnumber::text), '') IS NOT NULL
          AND s.injectiondate::text ~ '^\\s*\\d{{4}}-\\d{{2}}-\\d{{2}}'
          AND s.injectiondate::date BETWEEN CURRENT_DATE - {int(days_back)}
                                        AND CURRENT_DATE + {int(days_fwd)}
        ORDER BY s.injectiondate::date ASC, s.batchnumber
        LIMIT {int(limit)}
    """)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today = now.date()
    cohorts: dict[str, dict] = {}

    for r in rows:
        batch = str(r["batchnumber"]).strip()
        c = cohorts.setdefault(batch, {
            "batch_no": batch, "members": [],
            "products": set(), "sites": set(), "carriers": set(), "regions": set(),
        })
        for key, col in (("products", "product"), ("sites", "production_site"),
                         ("carriers", "carrier"), ("regions", "region")):
            v = str(r[col] or "").strip()
            if v:
                c[key].add(v)

        inj = _naive_dt(r["injectiondate"])
        delivered = bool(r["is_delivered"])
        cancelled = bool(r["is_cancelled"])
        active = not delivered and not cancelled
        level = "done"
        if active:
            if inj is not None and inj.date() < today:
                level = "overdue"
            elif inj is not None and (inj - now).total_seconds() <= 48 * 3600:
                level = "imminent"
            else:
                level = "upcoming"

        c["members"].append({
            "salesordernumber": r["salesordernumber"],
            "trackingnumber": r["trackingnumber"],
            "product": r["product"],
            "injectiondate": r["injectiondate"],
            "injectiontime": r["injectiontime"],
            "dosestatus": r["dosestatus"],
            "currentmilestone": r["currentmilestone"],
            "carrier": r["carrier"],
            "destinationname": r["destinationname"],
            "risk": r["riskbucket"] or r["risk"],
            "eta": r["etadeliverytime"],
            "vial_expiry": r["vialexpirationtime"],
            "status": "delivered" if delivered else "cancelled" if cancelled else "active",
            "level": level,
        })

    out = []
    for batch, c in cohorts.items():
        m = c["members"]
        active = [x for x in m if x["status"] == "active"]
        injs = sorted(d for d in (_naive_dt(x["injectiondate"]) for x in m) if d)
        m.sort(key=lambda x: (_LEVEL_ORDER.get(x["level"], 9),
                              _naive_dt(x["injectiondate"]) or datetime.max))
        products = sorted(c["products"])
        out.append({
            "batch_no": batch,
            "products": products,
            "product": products[0] if products else None,
            "sites": sorted(c["sites"]),
            "carriers": sorted(c["carriers"]),
            "regions": sorted(c["regions"]),
            "doses": len(m),
            "delivered": sum(1 for x in m if x["status"] == "delivered"),
            "cancelled": sum(1 for x in m if x["status"] == "cancelled"),
            "active": len(active),
            "overdue": sum(1 for x in active if x["level"] == "overdue"),
            "imminent": sum(1 for x in active if x["level"] == "imminent"),
            "upcoming": sum(1 for x in active if x["level"] == "upcoming"),
            "blast_radius": len(active),   # undelivered patients depending on this lot
            "risk_max": _max_risk(m),
            "earliest_injection": injs[0].date().isoformat() if injs else None,
            "latest_injection": injs[-1].date().isoformat() if injs else None,
            "batch_status": None,           # filled by enrichment (schema-adaptive)
            "patients": None,
            "members": m,
        })

    # rank: worst first — overdue, then imminent, then total undelivered, then size
    out.sort(key=lambda c: (c["overdue"], c["imminent"], c["active"], c["doses"]),
             reverse=True)

    await _enrich_from_batches(out[:100])

    summary = {
        "cohorts": len(out),
        "multi_dose_cohorts": sum(1 for c in out if c["doses"] > 1),
        "cohorts_at_risk": sum(1 for c in out if c["active"] > 0),
        "cohorts_overdue": sum(1 for c in out if c["overdue"] > 0),
        "doses_at_risk": sum(c["active"] for c in out),
        "overdue": sum(c["overdue"] for c in out),
        "imminent": sum(c["imminent"] for c in out),
        "largest_blast_radius": max((c["blast_radius"] for c in out), default=0),
    }
    return {
        "window": {"days_back": days_back, "days_fwd": days_fwd},
        "generated_at": now.isoformat() + "Z",
        "summary": summary,
        "cohorts": out,
    }


async def _enrich_from_batches(cohorts: list[dict]) -> None:
    """Best-effort batch_status + distinct-patient count from the 3A GEST2 batch
    table. Entirely optional — columns may not exist on the real schema, so we
    probe information_schema and skip anything absent."""
    if not cohorts:
        return
    cols = await cached("cohorts:batchcols", 600, _batch_columns)
    if "batch_no" not in cols:
        return
    batch_nos = [c["batch_no"] for c in cohorts]

    if "batch_status" in cols:
        order_col = next((x for x in ("updatedt", "audit_timestamp") if x in cols), None)
        tail = f", {order_col} DESC NULLS LAST" if order_col else ""
        try:
            srows = await fetch_all(f"""
                SELECT DISTINCT ON (batch_no) batch_no, batch_status
                FROM etl.threeagesttwo_batches_inbound
                WHERE batch_no::text = ANY($1::text[])
                ORDER BY batch_no{tail}
            """, batch_nos)
            status = {str(r["batch_no"]).strip(): r["batch_status"] for r in srows}
            for c in cohorts:
                c["batch_status"] = status.get(c["batch_no"])
        except Exception:  # noqa: BLE001 — enrichment must never break the view
            pass

    if "patient_id" in cols:
        try:
            prows = await fetch_all(f"""
                SELECT batch_no::text AS batch_no, COUNT(DISTINCT patient_id) AS n
                FROM etl.threeagesttwo_batches_inbound
                WHERE batch_no::text = ANY($1::text[])
                  AND NULLIF(btrim(patient_id::text), '') IS NOT NULL
                GROUP BY batch_no
            """, batch_nos)
            pat = {str(r["batch_no"]).strip(): int(r["n"]) for r in prows}
            for c in cohorts:
                c["patients"] = pat.get(c["batch_no"])
        except Exception:  # noqa: BLE001
            pass
