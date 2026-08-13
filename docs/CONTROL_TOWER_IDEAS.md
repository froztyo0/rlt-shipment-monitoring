# RLT Control Tower — Monitoring & Feature Concepts

A design brief for turning this dashboard into a **control tower** for the people
who run the whole radioligand-therapy dose network — not the person looking up one
parcel. Every concept below is grounded in data we already have in the `etl`
schema, keeps the database **strictly read-only**, and composes the intelligence
already shipped (Decay & Dose, Batch-Cohort Blast-Radius, Carrier ETA
Calibration, Chokepoints, Dead-Reckoning) into one operational surface.

> **Why RLT makes a control tower non-negotiable.** A control tower is the
> centralized nerve center of a logistics network — one team, total visibility,
> coordinated exception response. Ordinary freight can absorb a missed control
> tower; RLT cannot. Each shipment is **one patient's dose**, radioactive and
> decaying (Lu-177 t½ = 6.647 d), calibrated to a **fixed injection appointment**
> that can't slip and a batch that can't be re-made in time. The failure unit is
> a *patient cycle*, and the whole point of a tower is to see the miss coming
> while there's still time to act.

---

## The core idea

**A "Control Tower" section** (its own top-nav area) that answers, fleet-wide and
in priority order: *what needs a human in the next hour, who owns it, and what's
the play?* Today's pages are either per-shipment (detail) or per-analysis
(analytics, cohorts, chokepoints). The tower is the missing **operational** layer
that unifies them into a run-the-network cockpit with ownership, SLAs, and
escalation.

### One constraint to call out up front

Monitoring, scoring, ranking, forecasting — all **pure reads**, fully supported
today. The *only* thing that implies writes is **case state** (who acknowledged
an exception, its status, SLA clock). Three read-only-safe options:
1. **Client-side per-operator** (localStorage) — zero backend, ships immediately.
2. A **tiny separate state store** outside the `etl` schema (a few tables the app
   owns) — the clean long-term answer; never touches ETL data.
3. Integrate ack/ownership with the org's existing **ticketing/ITSM**.
Everything else in this doc needs neither.

---

## Ranked concepts

### 1. 🗼 Command Board — the single pane of glass  · effort S–M

**What:** the tower's home screen. A live fleet snapshot + a single **prioritized
action queue**: the top N doses that need intervention *now*, each ranked by
**patient impact × time-criticality**, with a one-line recommended action.

**Why it's tower-grade:** every existing view answers "how is *this* doing?" None
answers "of everything in the air, what do I touch first?" This is that list —
the difference between a dashboard and an operations desk.

**How:** compose signals already computed — injection slack (ops/injection-risk),
calibrated ETA miss (ETA calibration), decay verdict (dose), GPS stall/wrong-way
(dead-reckoning), batch blast-radius (cohorts), silent feeds (feeds/health) — into
one urgency score per active dose; rank; show top 10–20 with a "why" chip and a
suggested play. A fleet strip up top: in-flight · at-risk · overdue · delivered
today · doses-at-risk (patients).

**Data:** `etl.shipment` + the existing endpoints; no new sources.

---

### 2. 🎫 Exception & Escalation Queue — case management + SLA timers  · effort M

**What:** every exception (at-risk dose, silent feed, stalled GPS, batch hold,
milestone violation, missing POD) becomes a tracked **case** with severity, age,
**owner**, **SLA countdown**, and status (new → ack → in-progress → resolved). Auto-
escalate when a case isn't acknowledged inside its SLA.

**Why it's tower-grade:** a control tower is defined by *closing the loop* on
exceptions, not just displaying them. Ownership + SLA + escalation is what turns
"20 red flags" into "3 of them are yours and one breaches in 12 min."

**How:** exceptions are already detected fleet-wide (quality flags, RCA verdicts,
feed health, injection-risk). Wrap each in a case object; SLA per exception type
(e.g. GPS-lost 30 min, silent carrier feed 2 h, at-risk dose 1 h). **Case
state** uses the read-only-safe store above; detection stays pure-read.

**Data:** the flag/RCA/feed detections + a case store (option 1/2 above).

---

### 3. 🎯 Dose-Integrity & OTIF SLA Monitor  · effort M

**What:** the tower's scorecard of record. Two SLAs:
- **OTIF** (On-Time-In-Full) — the standard logistics grade, per carrier/lane/site.
- **Dose-Integrity SLA** *(RLT-specific, the one that actually matters)* — % of
  delivered doses that arrived **within the usable activity window** (not decayed
  below the ±10% tolerance by injection time). A shipment can be "on-time" and
  still deliver a **clinically wasted** dose; this is the metric that catches it.

**Why it's tower-grade:** towers run on SLAs and QBR-ready numbers. Dose-integrity
reframes success from "did the box arrive" to "did a usable dose reach the
patient" — the only definition that counts in RLT.

**How:** OTIF from delivered vs planned (analytics already computes on-time).
Dose-integrity = replay the decay model (`decay.py`) at actual delivery/injection
time for delivered doses with batch activity, count those still ≥ usable-low. SLA
breach board + trend over the window.

**Data:** `etl.shipment` (planned/actual delivery, injection) + batch activity
columns; reuses the decay physics.

---

### 4. 🔮 Predict-the-Miss Risk Engine  · effort M

**What:** one forward-looking **miss-probability** per active dose, fusing the
independent signals we built — carrier-bias-corrected ETA, GPS dead-reckoned ETA,
decay margin, chokepoint exposure, ETA-drift from `shipment_history`. Surfaces
"**doses to expedite now**" *hours before* raw slack goes negative.

**Why it's tower-grade:** the tower's job is to act early. Any one signal can be
wrong; agreeing signals (carrier is optimistic **and** GPS closing-speed is slow
**and** it routes through a concentrated hub) is a strong, early, explainable
alarm — deterministic, no ML.

**How:** a transparent weighted blend of the existing per-signal verdicts →
red/amber/green with the contributing reasons listed. Deliberately explainable so
an operator trusts (and can override) it.

**Data:** all existing intelligence endpoints; optionally `shipment_history` for
the ETA-revision derivative (schema-adaptive — degrade if absent).

---

### 5. 📡 Silent-Feed Watchtower  · effort S

**What:** promote feed-health to a first-class tower alarm: which source systems
(ROME, 3A GEST2, carrier, Sensitech) have gone **quiet or are rejecting**, with
"blind since" timers — because a tower flies blind the moment its feeds stop, and
that's exactly when it least knows it.

**Why it's tower-grade:** trust in the board depends on the data being live.
Surfacing *"we haven't heard from Carrier X in 3 h"* prevents false calm.

**How:** already computed in `/api/feeds/health` (silence/volume/reject anomalies)
— elevate it into the tower with per-feed SLA timers and an at-a-glance status
ribbon. Essentially free.

**Data:** the inbound/reject tables' `audit_timestamp` recency (existing).

---

### 6. 🏅 Carrier & Site Scorecards  · effort M

**What:** a single control-tower grade per **carrier** (OTIF, ETA bias, exception
rate, silent-feed incidents, dose-integrity) and per **treatment site** (on-time
receipt, POD compliance, chronic lanes) — the artifacts you bring to a carrier QBR
or a site conversation.

**Why it's tower-grade:** towers own the vendor/site relationship. One defensible
grade per partner, trended, turns anecdotes into accountability.

**How:** roll up analytics (carrier performance, ETA-calibration bias, chokepoint
share) + POD/receipt fields per carrier and per destination site.

**Data:** `etl.shipment` (carrier, destination, POD, delivery) + existing
aggregates.

---

### 7. 🔄 Shift-Handover Briefing  · effort M

**What:** a printable "**since the last shift**" digest for control-tower shift
changes: new exceptions, escalations, what resolved, doses delivered, doses now at
risk, and the open action queue — so nothing falls through the crack between shifts.

**Why it's tower-grade:** 24/7 towers live or die on clean handovers. A generated
brief beats a Slack scroll and a hurried verbal.

**How:** diff `etl.shipment` / `shipment_history` snapshots against an operator
cutoff (last-visit timestamp), typed change events, ranked by decay-weighted
slip; render to print/`.eml` (reuse the existing report/email plumbing).

**Data:** `shipment_history` (ETA/risk/milestone revisions) diffed vs live
`etl.shipment`.

---

### 8. 🗺️ Geographic Command Map  · effort M

**What:** the classic tower wall display — a world map with **every active dose**
plotted, colored by risk, clustered by region, hubs sized by throughput. Click a
cluster → drill to the doses. The macro complement to the per-shipment map we have.

**Why it's tower-grade:** spatial awareness of the whole network at once; where the
red is concentrating right now.

**How:** reuse the Leaflet map + last-known GPS/destination coords across all
active shipments; color by the risk engine (#4); overlay chokepoint hubs.

**Data:** `etl.sensitech_inbound_trip` last fixes + `etl.shipment` dest coords +
airport IATA — all already used per-shipment.

---

### 9. 📈 Demand vs Capacity Outlook  · effort L

**What:** upcoming **injection demand** (doses/day/site from the injection
calendar) laid against **network throughput** (historical lane/carrier capacity),
to pre-warn crunch days and pre-position — the tower's planning horizon.

**Why it's tower-grade:** towers don't only react; they look a week out. RLT demand
is unusually *predictable* (scheduled injections, known multi-cycle regimens), so a
forward view is genuinely actionable.

**How:** the injection-calendar aggregation (already built) forward, vs realized
per-lane throughput percentiles. Honest about assumptions; a planning aid, not a
promise. Caveat: true capacity/roster data isn't in `etl` — treat historical
throughput as the proxy.

**Data:** `etl.shipment` injection dates + historical transit/volume.

---

## Suggested sequencing

| Phase | Ships | Why first |
|---|---|---|
| **1** | Command Board (#1) + Silent-Feed Watchtower (#5) | Highest value, lowest cost — both compose existing signals; no writes. |
| **2** | Dose-Integrity/OTIF SLA (#3) + Predict-the-Miss (#4) | The tower's KPIs and its early-warning brain. |
| **3** | Exception/Escalation Queue (#2) | Adds the case store (client-side first), closing the loop. |
| **4** | Scorecards (#6), Handover (#7), Command Map (#8) | Relationship, shift, and spatial layers. |
| **5** | Demand vs Capacity (#9) | Planning horizon; largest and most assumption-bound. |

## Out of scope (data we don't have)

Live flight status / weather, real carrier capacity & roster, patient EHR /
clinical scheduling. These would sharpen #4 and #9 but require sources outside the
`etl` schema — noted so nobody assumes they're covered.

---

*Ideas only — no database or schema changes are implied by this document. The one
place writes appear (exception case state in #2) has read-only-safe options that
never touch the `etl` schema.*
