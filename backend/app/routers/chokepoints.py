"""Chokepoint / single-point-of-failure board.

Existing analytics list carriers and lanes as flat, independent counts. But the
live dose flow is a connected topology — every shipment threads a dispatch
ORIGIN, a CARRIER, zero-or-more airport HUBS, and a destination REGION — and for
un-reproducible JIT doses, concentration IS systemic risk. This decomposes the
active injection window into those node layers and asks, per node: "how many
un-injected doses would miss if this node went dark?" (its blast-radius), plus a
Herfindahl concentration index per layer so a lane with no fallback stands out.

Read-only, bounded (active injection window), set-based: one windowed shipment
scan + one set-based carrier_inbound hub lookup, aggregated in Python.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Query

from ..cache import cached
from ..db import fetch_all
from ..analysis import quality as q

router = APIRouter(prefix="/api/chokepoints", tags=["chokepoints"])

# layer key -> (display label, singular node label)
LAYERS = {
    "carrier": ("Carriers", "carrier"),
    "hub": ("Airport hubs", "hub"),
    "origin": ("Dispatch origins", "origin"),
    "region": ("Destination regions", "region"),
}


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


@router.get("")
async def chokepoints(
    days_back: int = Query(default=3, ge=0, le=30),
    days_fwd: int = Query(default=21, ge=1, le=90),
):
    return await cached(f"chokepoints:{days_back}:{days_fwd}", 90,
                        lambda: _compute(days_back, days_fwd))


async def _compute(days_back: int, days_fwd: int):
    rows = await fetch_all(f"""
        SELECT s.salesordernumber, s.trackingnumber, s.product, s.carrier,
               s.origin, s.region, s.destinationname, s.modeoftransportation,
               s.injectiondate, s.injectiontime, s.currentmilestone,
               {q.DELIVERED_SQL} AS is_delivered,
               {q.CANCELLED_SQL} AS is_cancelled
        FROM etl.shipment s
        WHERE {q.ACTIVE_SQL}
          AND s.injectiondate::text ~ '^\\s*\\d{{4}}-\\d{{2}}-\\d{{2}}'
          AND s.injectiondate::date BETWEEN CURRENT_DATE - {int(days_back)}
                                        AND CURRENT_DATE + {int(days_fwd)}
        ORDER BY s.injectiondate::date ASC
        LIMIT 1500
    """)

    so_ids = sorted({str(r["salesordernumber"] or "").strip() for r in rows
                     if str(r["salesordernumber"] or "").strip()})

    # set-based hub lookup: SO -> set of airport IATA codes it transits
    hubs_by_so: dict[str, set] = {}
    if so_ids:
        hrows = await fetch_all("""
            SELECT salesordernumber, departure_airport_iata AS dep, arrival_airport_iata AS arr
            FROM etl.carrier_inbound
            WHERE salesordernumber::text = ANY($1::text[])
              AND (NULLIF(btrim(departure_airport_iata::text), '') IS NOT NULL
                   OR NULLIF(btrim(arrival_airport_iata::text), '') IS NOT NULL)
        """, so_ids)
        for h in hrows:
            so = str(h["salesordernumber"] or "").strip()
            for code in (h["dep"], h["arr"]):
                code = str(code or "").strip().upper()
                if code:
                    hubs_by_so.setdefault(so, set()).add(code)

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today = now.date()
    nodes: dict[tuple[str, str], dict] = {}

    def node(layer: str, name: str) -> dict:
        key = (layer, name)
        return nodes.setdefault(key, {
            "layer": layer, "name": name, "doses": 0, "active": 0,
            "overdue": 0, "imminent": 0, "upcoming": 0,
            "products": set(), "members": [],
        })

    paths = []   # (origin, carrier, hub, region) per active dose, for the Sankey
    for r in rows:
        so = str(r["salesordernumber"] or "").strip()
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

        carrier_name = str(r["carrier"] or "").strip()
        region_name = str(r["region"] or "").strip()
        origin_name = str(r["origin"] or "").strip()
        hub_list = sorted(hubs_by_so.get(so, set()))
        targets = []
        if carrier_name:
            targets.append(("carrier", carrier_name))
        if region_name:
            targets.append(("region", region_name))
        if origin_name:
            targets.append(("origin", origin_name))
        for code in hub_list:
            targets.append(("hub", code))

        if active:
            paths.append((origin_name or "?", carrier_name or "?",
                          hub_list[0] if hub_list else "(direct)", region_name or "?"))

        member = {
            "salesordernumber": so, "trackingnumber": r["trackingnumber"],
            "product": r["product"], "carrier": r["carrier"],
            "injectiondate": r["injectiondate"], "currentmilestone": r["currentmilestone"],
            "level": level, "active": active,
        }
        for layer, name in targets:
            n = node(layer, name)
            n["doses"] += 1
            if r["product"]:
                n["products"].add(str(r["product"]).strip())
            if active:
                n["active"] += 1
                n[level] += 1
            if len(n["members"]) < 40:
                n["members"].append(member)

    # finalize + rank members within each node
    all_nodes = []
    for n in nodes.values():
        n["blast_radius"] = n["active"]
        n["products"] = sorted(n["products"])
        order = {"overdue": 0, "imminent": 1, "upcoming": 2, "done": 3}
        n["members"].sort(key=lambda m: order.get(m["level"], 9))
        all_nodes.append(n)

    # per-layer concentration (Herfindahl over active flow)
    layers_out = []
    for lk, (label, node_label) in LAYERS.items():
        lnodes = sorted((n for n in all_nodes if n["layer"] == lk),
                        key=lambda n: (n["active"], n["overdue"], n["doses"]), reverse=True)
        total_active = sum(n["active"] for n in lnodes)
        hhi = round(sum((n["active"] / total_active) ** 2 for n in lnodes if total_active), 3) if total_active else 0.0
        top = lnodes[0] if lnodes else None
        top_share = round(100 * top["active"] / total_active, 0) if (top and total_active) else 0
        layers_out.append({
            "key": lk, "label": label, "node_label": node_label,
            "node_count": len(lnodes), "total_active": total_active,
            "hhi": hhi, "concentration_pct": round(100 * hhi, 0),
            "sole_path": len([n for n in lnodes if n["active"] > 0]) == 1 and total_active > 0,
            "top_node": top["name"] if top else None, "top_share_pct": top_share,
            "nodes": [_public(n) for n in lnodes],
        })

    top_chokepoints = sorted((n for n in all_nodes if n["active"] > 0),
                             key=lambda n: (n["overdue"], n["active"], n["doses"]), reverse=True)[:12]

    summary = {
        "active_doses": len(so_ids),
        "nodes": len(all_nodes),
        "chokepoints": sum(1 for n in all_nodes if n["active"] >= 3),
        "worst_blast_radius": max((n["active"] for n in all_nodes), default=0),
        "most_concentrated_layer": max(layers_out, key=lambda l: l["hhi"])["label"] if layers_out else None,
        "sole_path_layers": [l["label"] for l in layers_out if l["sole_path"]],
    }
    return {
        "window": {"days_back": days_back, "days_fwd": days_fwd},
        "summary": summary,
        "top_chokepoints": [_public(n) for n in top_chokepoints],
        "layers": layers_out,
        "flow": _build_flow(paths),
    }


LAYER_LABELS = ["Origin", "Carrier", "Hub", "Region"]


def _build_flow(paths: list, cap: int = 8) -> dict:
    """Sankey data: 4 stacked columns (origin→carrier→hub→region) with the doses
    lumped beyond the top `cap` per column into '(other)', and the flow links
    between adjacent columns. One clean left-to-right dose-flow picture."""
    if not paths:
        return {"columns": [], "links": []}
    raw = [{}, {}, {}, {}]
    for p in paths:
        for i in range(4):
            raw[i][p[i]] = raw[i].get(p[i], 0) + 1
    keep = [{k for k, _ in sorted(c.items(), key=lambda kv: -kv[1])[:cap]} for c in raw]

    def nm(i: int, name: str) -> str:
        return name if name in keep[i] else "(other)"

    colnodes = [{}, {}, {}, {}]
    links: dict = {}
    for p in paths:
        lumped = [nm(i, p[i]) for i in range(4)]
        for i in range(4):
            colnodes[i][lumped[i]] = colnodes[i].get(lumped[i], 0) + 1
        for i in range(3):
            k = (i, lumped[i], lumped[i + 1])
            links[k] = links.get(k, 0) + 1

    columns = [{
        "layer": i, "label": LAYER_LABELS[i],
        "nodes": [{"name": k, "value": v} for k, v in sorted(cn.items(), key=lambda kv: -kv[1])],
    } for i, cn in enumerate(colnodes)]
    linkout = [{"from_layer": k[0], "from": k[1], "to": k[2], "value": v}
               for k, v in sorted(links.items(), key=lambda kv: -kv[1])]
    return {"columns": columns, "links": linkout}


def _public(n: dict) -> dict:
    return {
        "layer": n["layer"], "name": n["name"],
        "doses": n["doses"], "active": n["active"], "blast_radius": n["active"],
        "overdue": n["overdue"], "imminent": n["imminent"], "upcoming": n["upcoming"],
        "products": n["products"], "members": n["members"],
    }
