"""Carrier milestone sequence validation.

The expected sequence per carrier/mode lives in etl.carrier_milestone_air and
etl.carrier_milestone_road (event -> ui_milestone, milestone_flag, step).
We replay the raw carrier_inbound events for a sales order in event-timestamp
order and flag:

  - invalid_event        : event not mapped for this carrier in either table
  - wrong_mode_event     : event only exists in the other mode's mapping
  - out_of_order         : step goes backwards as event time advances
  - audit_out_of_order   : carrier transmitted events (audit_timestamp order)
                           in a different order than they occurred
  - duplicate_event      : identical event repeated at the same timestamp
  - missed_steps         : delivery confirmed but earlier milestone flags
                           never seen (gaps in the story)
"""
from datetime import datetime
from typing import Optional

from ..db import fetch_all

_mapping_cache: Optional[dict] = None


async def load_mappings(force: bool = False) -> dict:
    """{mode: {carrier: {event_lower: {ui_milestone, flag, step}}}} — tiny
    tables, cached for the process lifetime."""
    global _mapping_cache
    if _mapping_cache is not None and not force:
        return _mapping_cache
    out: dict = {"AIR": {}, "ROAD": {}}
    for mode, table in (("AIR", "etl.carrier_milestone_air"), ("ROAD", "etl.carrier_milestone_road")):
        rows = await fetch_all(
            f'SELECT carriername, "event", ui_milestone, milestone_flag, carrier_milestone_step FROM {table}'
        )
        for r in rows:
            carrier = (r["carriername"] or "").strip().upper()
            event = (r["event"] or "").strip().lower()
            if not carrier or not event:
                continue
            out[mode].setdefault(carrier, {})[event] = {
                "ui_milestone": (r["ui_milestone"] or "").strip() or None,
                "flag": _to_int(r["milestone_flag"]),
                "step": _to_int(r["carrier_milestone_step"]),
            }
    _mapping_cache = out
    return out


def _to_int(v) -> Optional[int]:
    if v is None:
        return None
    try:
        s = str(v).strip()
        return int(float(s)) if s else None
    except ValueError:
        return None


def _to_dt(v) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def infer_mode(shipment: Optional[dict]) -> str:
    """AIR vs ROAD from the shipment row; defaults to AIR (worst case is a
    wrong_mode_event note, never a crash)."""
    if not shipment:
        return "AIR"
    mot = " ".join(
        str(shipment.get(k) or "")
        for k in ("modeoftransportation", "modeoftransportation_3a2", "shipmenttype")
    ).lower()
    if any(w in mot for w in ("road", "drive", "ground", "truck", "courier")) and "air" not in mot:
        return "ROAD"
    if "air" in mot or "flight" in mot:
        return "AIR"
    if str(shipment.get("transportmode_flight") or "").strip() or str(shipment.get("flightnumber") or "").strip():
        return "AIR"
    return "ROAD" if mot else "AIR"


def validate_events(events: list[dict], carrier_hint: Optional[str], mode: str, mappings: dict) -> dict:
    """events: carrier_inbound rows for one SO. Returns enriched events +
    a list of issues."""
    issues: list[dict] = []
    enriched: list[dict] = []

    def lookup(carrier: str, event: str):
        c, e = carrier.strip().upper(), event.strip().lower()
        primary = mappings.get(mode, {}).get(c, {}).get(e)
        other_mode = "ROAD" if mode == "AIR" else "AIR"
        secondary = mappings.get(other_mode, {}).get(c, {}).get(e)
        return primary, secondary

    dated = []
    for r in events:
        ev_ts = _to_dt(r.get("eventtimestamp"))
        au_ts = _to_dt(r.get("audit_timestamp"))
        carrier = (r.get("carriername") or carrier_hint or "").strip()
        event = (r.get("event") or "").strip()
        primary, secondary = lookup(carrier, event) if carrier and event else (None, None)
        item = {
            "carrier": carrier or None,
            "event": event or None,
            "event_description": r.get("event_description"),
            "eventtimestamp": ev_ts.isoformat() if ev_ts else None,
            "audit_timestamp": au_ts.isoformat() if au_ts else None,
            "ui_milestone": primary["ui_milestone"] if primary else None,
            "step": primary["step"] if primary else None,
            "flag": primary["flag"] if primary else None,
            "mapped": primary is not None,
            "mapped_other_mode": secondary is not None,
            "issues": [],
        }
        if event and not primary:
            kind = "wrong_mode_event" if secondary else "invalid_event"
            item["issues"].append(kind)
            issues.append({
                "type": kind,
                "severity": "warning" if secondary else "serious",
                "event": event,
                "carrier": carrier or None,
                "at": item["eventtimestamp"],
                "detail": (
                    f"'{event}' is mapped for {carrier} in the "
                    f"{'ROAD' if mode == 'AIR' else 'AIR'} table but this shipment is {mode}"
                    if secondary
                    else f"'{event}' is not a known {mode} milestone event for carrier '{carrier or '?'}'"
                ),
            })
        enriched.append(item)
        if ev_ts:
            dated.append((ev_ts, au_ts, item))

    # ---- ordering checks over dated, mapped events -------------------------
    dated.sort(key=lambda t: (t[0], t[1] or t[0]))
    max_step = None
    max_step_event = None
    seen_keys = set()
    seen_flags = set()
    delivered_at = None
    for ev_ts, _au, item in dated:
        key = (item["event"], item["eventtimestamp"])
        if key in seen_keys:
            if "duplicate_event" not in item["issues"]:
                item["issues"].append("duplicate_event")
                issues.append({
                    "type": "duplicate_event", "severity": "info",
                    "event": item["event"], "carrier": item["carrier"],
                    "at": item["eventtimestamp"],
                    "detail": f"'{item['event']}' repeated with identical timestamp",
                })
        seen_keys.add(key)
        step = item["step"]
        flag = item["flag"]
        if step is None or (flag is not None and flag == 0):
            continue  # unmapped or cancellation events don't advance the ladder
        if max_step is not None and step < max_step:
            item["issues"].append("out_of_order")
            issues.append({
                "type": "out_of_order", "severity": "serious",
                "event": item["event"], "carrier": item["carrier"],
                "at": item["eventtimestamp"],
                "detail": (
                    f"'{item['event']}' (step {step}) occurred after "
                    f"'{max_step_event}' (step {max_step}) — sequence went backwards"
                ),
            })
        if max_step is None or step >= max_step:
            max_step, max_step_event = step, item["event"]
        if flag is not None:
            seen_flags.add(flag)
        if item["ui_milestone"] and "delivery" in item["ui_milestone"].lower():
            delivered_at = ev_ts

    # ---- transmission order vs occurrence order ----------------------------
    # quadratic check — bound it so a pathological SO can't stall the loop
    with_audit = [(ev, au, item) for ev, au, item in dated if au is not None][:300]
    if len(with_audit) >= 2:
        by_audit = sorted(with_audit, key=lambda t: t[1])
        for pos, (ev_ts, _au, item) in enumerate(by_audit):
            later_sent_earlier_event = [
                other for other in by_audit[:pos] if other[0] > ev_ts
            ]
            if later_sent_earlier_event and "audit_out_of_order" not in item["issues"]:
                item["issues"].append("audit_out_of_order")
                issues.append({
                    "type": "audit_out_of_order", "severity": "warning",
                    "event": item["event"], "carrier": item["carrier"],
                    "at": item["eventtimestamp"],
                    "detail": (
                        f"'{item['event']}' was transmitted after events that "
                        "happened later — carrier sent updates out of order/late"
                    ),
                })

    # ---- gap check: delivered but early flags never seen --------------------
    if delivered_at is not None:
        max_flag = max(seen_flags) if seen_flags else 0
        expected = set(range(1, max_flag + 1))
        missing = sorted(expected - seen_flags)
        if missing:
            issues.append({
                "type": "missed_steps", "severity": "warning",
                "event": None, "carrier": carrier_hint,
                "at": delivered_at.isoformat(),
                "detail": f"Delivery confirmed but milestone phase(s) {missing} never reported",
            })

    return {"events": enriched, "issues": issues, "mode": mode}
