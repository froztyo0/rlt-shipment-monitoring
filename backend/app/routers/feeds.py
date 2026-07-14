"""Inbound feed health — is data still flowing into the etl tables?

For every inbound/reject table we track:
  - last_received (unbounded MAX so a feed dead for weeks still reports)
  - rows in the last 24h vs a 14-day daily baseline (median incl. zero days)
  - status flags:
      silent        inbound feed exceeded its max expected gap      serious/critical
      low_volume    24h volume < 30% of the daily median            warning
      volume_spike  24h volume > 3x the daily median                info
      reject_spike  reject rows spiking vs their own baseline       serious
      query_error   table missing / not readable                    warning
A reject table being quiet is GOOD, so silence only applies to inbound kinds.
Whole response is cached; cost is ~2 bounded queries per table per TTL.
"""
import logging
import statistics
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

from ..cache import cached
from ..db import fetch_all, fetch_one

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/feeds", tags=["feeds"])

BASELINE_DAYS = 14

# key, label, table, ts column, max expected gap (hours), kind
FEEDS = [
    ("rome_orders", "ROME orders", "etl.rome_inbound_orders", "audit_timestamp", 24, "inbound"),
    ("rome_rejects", "ROME rejects", "etl.rome_inbound_rejects", "audit_timestamp", None, "rejects"),
    ("carrier_events", "Carrier events", "etl.carrier_inbound", "audit_timestamp", 12, "inbound"),
    ("carrier_rejects", "Carrier rejects", "etl.carrier_inbound_rejects", "audit_timestamp", None, "rejects"),
    ("sensitech_pings", "Sensitech pings", "etl.sensitech_inbound_trip", "audit_timestamp", 6, "inbound"),
    ("sensitech_rejects", "Sensitech rejects", "etl.sensitech_inbound_rejects", "audit_timestamp", None, "rejects"),
    ("a2_sales", "3A GEST2 sales", "etl.threeagesttwo_sales_inbound", "audit_timestamp", 24, "inbound"),
    ("a2_batches", "3A GEST2 batches", "etl.threeagesttwo_batches_inbound", "audit_timestamp", 24, "inbound"),
    ("a2_sales_fullload", "3A GEST2 sales full-load", "etl.threeagesttwo_sales_inbound_fullload", "load_timestamp", 36, "inbound"),
    ("a2_batches_fullload", "3A GEST2 batches full-load", "etl.threeagesttwo_batches_inbound_fullload", "load_timestamp", 36, "inbound"),
]

_SEV_RANK = {"good": 0, "info": 1, "warning": 2, "serious": 3, "critical": 4}


@router.get("/health")
async def feed_health():
    return await cached("feeds:health", 120, _compute_feed_health)


async def _compute_feed_health():
    feeds = []
    for key, label, table, ts, max_gap_h, kind in FEEDS:
        try:
            feeds.append(await _check_feed(key, label, table, ts, max_gap_h, kind))
        except Exception as e:  # noqa: BLE001 — a missing table must not kill the panel
            log.warning("feed health query failed for %s: %s", table, e)
            feeds.append({
                "key": key, "label": label, "table": table, "kind": kind,
                "last_received": None, "age_hours": None, "last_24h": 0,
                "median_daily": 0, "daily": [], "statuses": [
                    {"code": "query_error", "severity": "warning",
                     "detail": f"Could not read {table}: {type(e).__name__}"}],
                "severity": "warning",
            })
    feeds.sort(key=lambda f: -_SEV_RANK.get(f["severity"], 0))
    worst = feeds[0]["severity"] if feeds else "good"
    problem_count = sum(1 for f in feeds if _SEV_RANK.get(f["severity"], 0) >= _SEV_RANK["warning"])
    return {"feeds": feeds, "worst_severity": worst, "problem_feeds": problem_count,
            "baseline_days": BASELINE_DAYS}


async def _check_feed(key: str, label: str, table: str, ts: str,
                      max_gap_h: int | None, kind: str) -> dict:
    head = await fetch_one(f"""
        SELECT (SELECT MAX({ts}) FROM {table}) AS last_received,
               COUNT(*) FILTER (WHERE {ts} >= now() - interval '24 hours') AS last_24h
        FROM {table}
        WHERE {ts} >= now() - make_interval(days => {BASELINE_DAYS})
    """)
    series = await fetch_all(f"""
        SELECT date_trunc('day', {ts})::date AS day, COUNT(*) AS n
        FROM {table}
        WHERE {ts} >= now() - make_interval(days => {BASELINE_DAYS})
        GROUP BY 1 ORDER BY 1
    """)

    # fill missing days with 0 — silence must drag the baseline down
    by_day = {str(r["day"]): int(r["n"]) for r in series}
    today = datetime.now(timezone.utc).date()
    daily = []
    for i in range(BASELINE_DAYS, -1, -1):
        d = today - timedelta(days=i)
        daily.append({"day": d.isoformat(), "n": by_day.get(d.isoformat(), 0)})
    # baseline excludes today (partial day would skew the median low)
    baseline = [d["n"] for d in daily[:-1]]
    median = statistics.median(baseline) if baseline else 0

    last_received = head["last_received"] if head else None
    age_hours = None
    if isinstance(last_received, datetime):
        now = datetime.now(timezone.utc) if last_received.tzinfo else datetime.now()
        age_hours = round((now - last_received).total_seconds() / 3600.0, 1)
    last_24h = int(head["last_24h"] or 0) if head else 0

    statuses = []
    if kind == "inbound" and max_gap_h is not None:
        if last_received is None:
            statuses.append({"code": "silent", "severity": "critical",
                             "detail": "No rows ever received (or none with a timestamp)"})
        elif age_hours is not None and age_hours > max_gap_h:
            sev = "critical" if age_hours > 2 * max_gap_h else "serious"
            statuses.append({"code": "silent", "severity": sev,
                             "detail": f"Nothing received for {age_hours:.0f}h "
                                       f"(expected at most {max_gap_h}h between rows)"})
    if median >= 5 and last_24h < 0.3 * median and kind == "inbound":
        statuses.append({"code": "low_volume", "severity": "warning",
                         "detail": f"Only {last_24h} rows in 24h vs a typical {median:.0f}/day"})
    if median >= 5 and last_24h > 3 * median:
        code = "reject_spike" if kind == "rejects" else "volume_spike"
        statuses.append({"code": code,
                         "severity": "serious" if kind == "rejects" else "info",
                         "detail": f"{last_24h} rows in 24h vs a typical {median:.0f}/day"})
    if kind == "rejects" and median < 5 and last_24h >= 20:
        statuses.append({"code": "reject_spike", "severity": "serious",
                         "detail": f"{last_24h} rejects in 24h on a normally quiet feed"})

    severity = "good"
    for st in statuses:
        if _SEV_RANK[st["severity"]] > _SEV_RANK[severity]:
            severity = st["severity"]

    return {
        "key": key, "label": label, "table": table, "kind": kind,
        "last_received": last_received.isoformat() if isinstance(last_received, datetime) else None,
        "age_hours": age_hours,
        "last_24h": last_24h,
        "median_daily": median,
        "daily": daily,
        "statuses": statuses,
        "severity": severity,
    }
