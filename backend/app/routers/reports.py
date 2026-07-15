"""Ops reporting tools — run the carrier-issue report on demand (never
auto-fetched by the dashboard) and turn the results into carrier emails.

POST /api/reports/carrier-issues        -> per-order flags + per-carrier tracker
POST /api/reports/carrier-issues/email  -> subject + HTML body + .eml (X-Unsent)
"""
from datetime import date
from email.message import EmailMessage
from html import escape
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..carrier_config import ISSUE_CATALOG
from ..db import fetch_all
from ..reports_sql import MAX_REPORT_ROWS, build_carrier_issue_sql, build_event_detail_sql

# issues whose observation text we specialize with the actual event names
DETAIL_ISSUES = {"missing_events", "event_after_delivery", "unordered_events"}


def _sentence(code: str, events: list[str], fallback: str) -> str:
    if not events:
        return fallback
    joined = ", ".join(events)
    if code == "missing_events":
        return (f"{joined} — these expected carrier events are missing for the affected orders. "
                "Please note that the missing events vary by order; not every order is missing "
                "all the events shown.")
    if code == "event_after_delivery":
        return ("We observed that some shipment events were received out of sequence after the "
                f"delivery event. Specifically, additional {joined} event(s) were received after "
                "the shipment had already been marked as delivered.")
    if code == "unordered_events":
        return (f"The following carrier events were received out of the expected milestone "
                f"sequence: {joined}.")
    return fallback

router = APIRouter(prefix="/api/reports", tags=["reports"])

NON_ISSUE_COLUMNS = {
    "injection_date", "salesordernumber", "ordertype", "carriername",
    "carrier_trackingid", "derived_mode", "carrier_event_count",
    "has_any_carrier_issue",
}


class ReportRequest(BaseModel):
    start_date: date
    end_date: date
    carriers: Optional[list[str]] = None  # None = all


@router.post("/carrier-issues")
async def carrier_issues(req: ReportRequest):
    if req.end_date < req.start_date:
        raise HTTPException(status_code=400, detail="end_date is before start_date")
    if (req.end_date - req.start_date).days > 92:
        raise HTTPException(status_code=400, detail="window too large (max 92 days)")

    # carrier filter is pushed into the SQL (so the LIMIT can't strip a
    # requested carrier's rows before we filter) — pass uppercased list or None
    wanted = sorted({c.strip().upper() for c in (req.carriers or []) if c.strip()})
    rows = await fetch_all(build_carrier_issue_sql(), req.start_date, req.end_date, wanted or None)

    items = [{**r, "carriername": (str(r.get("carriername") or "UNKNOWN").strip() or "UNKNOWN")}
             for r in rows]
    so_list = sorted({str(r.get("salesordernumber") or "").strip()
                      for r in items if str(r.get("salesordernumber") or "").strip()})

    # specific event anomalies per order (for the missing/out-of-order sentences)
    order_events: dict[str, dict[str, list[str]]] = {}
    if so_list:
        for r in await fetch_all(build_event_detail_sql(), req.start_date, req.end_date):
            so = str(r.get("salesordernumber") or "").strip()
            ev = str(r.get("event") or "").strip()
            status = r.get("event_status")
            if not so or not ev or so not in set(so_list):
                continue
            key = {"MISSING_EVENT": "missing_events",
                   "AFTER_DELIVERY": "event_after_delivery",
                   "OUT_OF_ORDER": "unordered_events"}.get(status)
            if not key:
                continue
            bucket = order_events.setdefault(so, {}).setdefault(key, [])
            if ev not in bucket:
                bucket.append(ev)

    # carrier tracking id now comes resolved on each report row (best non-blank
    # across the order's carrier events, computed in the report SQL)
    tid_map = {
        str(r.get("salesordernumber") or "").strip(): str(r["carrier_trackingid"]).strip()
        for r in items
        if str(r.get("carrier_trackingid") or "").strip()
    }

    # per-carrier issue tracker, keyed case-insensitively (matches the SQL's
    # UPPER(TRIM(...)) carrier identity, so 'MNX' and 'Mnx' don't split)
    tracker: dict[str, dict[str, dict]] = {}
    for r in items:
        carrier = r["carriername"].upper()
        so = str(r.get("salesordernumber") or "").strip()
        for col, val in r.items():
            if col in NON_ISSUE_COLUMNS or not val or col not in ISSUE_CATALOG:
                continue
            name, description = ISSUE_CATALOG[col]
            slot = tracker.setdefault(carrier, {}).setdefault(col, {
                "code": col, "name": name, "description": description,
                "orders": [], "tracking_ids": [],
            })
            if so and so not in slot["orders"]:
                slot["orders"].append(so)
                tid = tid_map.get(so)
                if tid and tid not in slot["tracking_ids"]:
                    slot["tracking_ids"].append(tid)

    summary = []
    for carrier in sorted(tracker):
        issues = sorted(tracker[carrier].values(), key=lambda i: -len(i["orders"]))
        for i in issues:
            if i["code"] in DETAIL_ISSUES:
                events: list[str] = []
                for o in i["orders"]:
                    for ev in order_events.get(o, {}).get(i["code"], []):
                        if ev not in events:
                            events.append(ev)
                i["events"] = sorted(events)
                i["description"] = _sentence(i["code"], i["events"], i["description"])
        all_orders = {o for i in issues for o in i["orders"]}
        summary.append({
            "carrier": carrier,
            "total_affected_orders": len(all_orders),
            "issue_count": len(issues),
            "issues": [{**i, "order_count": len(i["orders"])} for i in issues],
        })

    return {
        "start_date": req.start_date.isoformat(),
        "end_date": req.end_date.isoformat(),
        "row_count": len(items),
        "truncated": len(rows) >= MAX_REPORT_ROWS,
        "carriers": summary,
        "rows": items,
    }


# --------------------------------------------------------------------------
# email drafts
# --------------------------------------------------------------------------
class EmailIssue(BaseModel):
    name: str
    description: str
    orders: list[str] = Field(default_factory=list)
    tracking_ids: list[str] = Field(default_factory=list)


class EmailRequest(BaseModel):
    carrier: str
    issues: list[EmailIssue]
    to: str = ""
    cc: str = ""
    subject: Optional[str] = None
    intro: Optional[str] = None
    outro: Optional[str] = None
    signature: str = "[Your Name]"
    sample_limit: int = Field(default=5, ge=1, le=25)


def _issue_table_html(issues: list[EmailIssue], sample_limit: int) -> str:
    # blue header, bold black header text (per ops preference)
    th = ('style="background-color: #8EAADB; color: #000000; font-weight: bold; '
          'text-align: center; padding: 6px; border: 1px solid #4472C4;"')
    td = 'style="vertical-align: top; padding: 6px; border: 1px solid #d9d9d9;"'
    tdc = ('style="text-align: center; vertical-align: top; padding: 6px; '
           'border: 1px solid #d9d9d9;"')
    rows = []
    for i, it in enumerate(issues, start=1):
        samples = ", ".join(list(dict.fromkeys(it.orders))[:sample_limit])
        tracking_all = [t for t in dict.fromkeys(it.tracking_ids) if t]
        tracking = (", ".join(tracking_all[:sample_limit]) if tracking_all
                    else "Not provided by carrier")
        rows.append(f"""
        <tr>
            <td {tdc}>{i}</td>
            <td {td}><b>{escape(it.name)}</b></td>
            <td {td}>{escape(it.description)}</td>
            <td {td}>{escape(samples)}</td>
            <td {td}>{escape(tracking)}</td>
        </tr>""")
    return f"""
    <table cellspacing="0" cellpadding="0"
           style="border-collapse: collapse; font-family: Calibri, Arial, sans-serif;
                  font-size: 11pt; margin-bottom: 14px; width: 100%;">
        <tr>
            <th {th}>#</th><th {th}>Issue</th><th {th}>Observation</th>
            <th {th}>Sales Orders</th><th {th}>Carrier Tracking IDs</th>
        </tr>
        {''.join(rows)}
    </table>"""


@router.post("/carrier-issues/email")
async def carrier_issue_email(req: EmailRequest):
    if not req.issues:
        raise HTTPException(status_code=400, detail="No issues selected")
    carrier = req.carrier.strip() or "UNKNOWN"
    subject = req.subject or f"NEXUS Prod - {carrier} Data Quality Observations"
    intro = req.intro or (
        f"We have identified certain issues in the tracking data received from "
        f"<b>{escape(carrier)}</b>. Could you please look into these observations "
        f"and help us with the corresponding RCA?"
    )
    outro = req.outro or "Please let us know if you require any additional details from the Nexus side."

    html = f"""
<html>
<body style="font-family: Calibri, Arial, sans-serif; font-size: 11pt;">
    <p>Hi Team,</p>
    <p>I hope you are doing well.</p>
    <p>{intro}</p>
    <p>Please find the required details below:</p>
    {_issue_table_html(req.issues, req.sample_limit)}
    <p>{escape(outro)}</p>
    <p>Best regards,<br>{escape(req.signature)}</p>
</body>
</html>"""

    msg = EmailMessage()
    if req.to.strip():
        msg["To"] = req.to.strip()
    if req.cc.strip():
        msg["Cc"] = req.cc.strip()
    msg["Subject"] = subject
    msg["X-Unsent"] = "1"  # Outlook opens the .eml as an editable, unsent draft
    msg.set_content("This message requires an HTML-capable mail client.")
    msg.add_alternative(html, subtype="html")

    return {"carrier": carrier, "subject": subject, "html": html, "eml": msg.as_string()}
