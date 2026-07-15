# RLT Shipment Monitoring — Ops Observability Dashboard

Read-only observability dashboard over the `etl` schema (AWS RDS Postgres).
It doesn't just *serve* data — it **flags problems on its own**: blank fields
are traced back to the source system that failed to deliver them, carrier
milestone sequences are replayed against the expected maps, GPS trails are
scanned for ghost pings, and overdue injections get an automatic root-cause
verdict.

**FastAPI** backend · **React + Vite + Tailwind** frontend · zero writes
(every DB session is opened with `default_transaction_read_only=on`).

---

## Quick start

### 1. Backend

```bash
cd backend
uv venv --python 3.12 .venv          # or: python -m venv .venv
uv pip install -r requirements.txt --python .venv/Scripts/python.exe
copy .env.example .env               # then fill in your RDS credentials
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000
```

`.env` is currently pointed at the **local mock DB** (see below). Swap in the
RDS host/user/password for real data. On first start the backend downloads
the [airport-codes dataset](https://github.com/datasets/airport-codes) into
`backend/data/` (once, ~6 MB).

### 2. Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173  (proxies /api -> :8000)
```

### 3. Optional: local mock DB (no RDS needed)

```bash
docker run -d --name rlt-mockdb -e POSTGRES_PASSWORD=mockpass \
  -e POSTGRES_DB=rltmock -p 55432:5432 postgres:16-alpine
docker exec -i rlt-mockdb psql -U postgres -d rltmock < backend/mockdb/init.sql
```

`backend/mockdb/init.sql` seeds shipments covering every failure mode (missing
batch, rejected carrier feed, ghost pings, out-of-order milestones,
cancelled-upstream, delivered-but-never-closed, GPS lost) plus ~36 synthetic
shipments so the analytics charts have meaningful distributions.

> **Note:** `backend/mockdb/` is intentionally **git-ignored** — it contains
> `CREATE`/`INSERT` DDL and is kept local-only so it can never be run against
> the wrong database by accident. The file is not in the repo; it lives on the
> dev machine only.

---

## What it detects

### Data-quality flags (per shipment row, evaluated inline in SQL)

| Flag | Severity | Meaning |
|---|---|---|
| `missing_batch` | serious | no batch → traced to `threeagesttwo_batches_inbound` / `_fullload` |
| `missing_carrier` | serious | no carrier → traced to `carrier_inbound` / `_rejects` |
| `missing_carrier_tracking` | warning | active shipment without carrier tracking id |
| `missing_planned_delivery` | serious | traced to ROME order |
| `missing_injection_date` | critical | dose scheduling unknown |
| `missing_dest_coords` | warning | geofence/ETA impossible |
| `missing_route` | warning | matches *Missing Routing Information Alert* |
| `missing_flight_air` | warning | AIR shipment without flight number |
| `missing_eta` | info | in transit without ETA |
| `gps_stale` | serious | departed, no ping in `GPS_STALE_HOURS` |
| `no_sensitech_data` | serious | departed, never a single fix |
| `stale_injection` | critical | injection date passed, not delivered/cancelled → RCA |
| `delivered_no_pod` | warning | matches *POD Missed Alert* |
| `upstream_silent_*` | info/warning | ROME / 3A GEST2 / carrier feeds silent |

Every flag drill-down answers **"where is the data?"** — *present upstream
(pipeline broke)* vs *rejected (see error_message)* vs *never received*.

### Ghost pings (`/api/shipments/{tn}/pings`)

Per consecutive-ping speed + bearing math over `sensitech_inbound_trip`:

- `teleport` — implied speed > 1,100 km/h (faster than a commercial jet)
- `short_hop` — > 300 km/h over < 80 km (GPS scatter, not a flight)
- `bounce` — A→B→A bearing reversal (~180°) at high speed, no net movement
- `invalid_coords` — null / out-of-range / (0,0) null island
- `time_conflict` — same timestamp, > 1 km apart

### Flight inference & airports

Ping gaps ≥ 25 min covering ≥ 150 km at ≥ 120 km/h become inferred **air
legs**; the nearest IATA airports (large/medium preferred, 120 km radius) are
attached and plotted. Carrier-reported `departure/arrival_airport_iata` and
`flight_details` from `carrier_inbound` are shown as authoritative when present.

### Milestone sequence validation

Raw `carrier_inbound` events are replayed in event-time order against
`carrier_milestone_air` / `carrier_milestone_road` (mode inferred from the
shipment row):

- `invalid_event` — event not in the carrier's map at all
- `wrong_mode_event` — event exists only in the other mode's map
- `out_of_order` — step number goes backwards over time
- `audit_out_of_order` — carrier *transmitted* events in a different order
  than they occurred (audit_timestamp vs eventtimestamp)
- `duplicate_event`, `missed_steps` (delivered but phases never reported)

### Analytics (`/api/analytics/*`, Analytics page)

Carrier-performance and fleet analytics over `etl.shipment`, windowed by
injection date (30/60/90/180 days) and cached: on-time delivery rate and
average transit time per carrier, shipment volume, delivery-status
distribution, air/road split, volume by region/product, top origin→destination
lanes, and a weekly on-time-vs-late trend. Charts are hand-rolled inline SVG on
the shared palette (bars, donuts, stacked columns) — no chart-library
dependency, theme-aware, with legends and hover labels.

### Shipment detail page

Click any tracking number to open the detail view: a header status pill + a
**KPI strip** (time in transit, ETA-vs-planned delta, distance remaining,
time-to-injection countdown, on-time projection), a **horizontal milestone
stepper** (current step, per-step timestamps, time-in-stage), the map (Carto
basemap, theme-aware) with **layer toggles** (actual trail / planned route /
pings / ghosts / airports), a **replay scrubber**, distinct markers (aircraft
silhouette, airport badge, delivery-truck current position, destination pin), and an
**animated aircraft** that tracks a predicted in-flight position along the
departure→arrival path while the shipment is airborne, the per-SO milestone
panel, a **GPS trip-analytics** strip (ground-speed profile with the air-leg
threshold, per-trip breakdown, ghost-cause donut — all derived from the pings
already fetched, no extra queries), and an **order
lifecycle timeline** showing when each source system delivered data (ROME →
3A GEST2 full-load & incremental → carrier events → Sensitech), with the
full-load stages keyed on `load_timestamp` and the rest on `audit_timestamp`.

### Injection outlook (`/api/kpis/injections`)

Today / tomorrow / future (next 30 days) injections from `etl.shipment`, each
with a mutually-exclusive status ladder — cancelled > delivered > arrived
(`routestatus`) > in transit (departed) > not started — plus **on-time vs
late** for delivered doses (day precision vs `planneddeliverydate`),
critical-risk and open-alert counts, and an **air vs road** split.

### Carrier issue report + email drafts (`/api/reports/...`, Reports page)

The ops team's hand-run carrier-quality SQL, productized. Pick an injection
window and carriers, hit **Run** (nothing is fetched automatically): latest
non-cancelled ROME orders are replayed against carrier events and the
expected milestone maps, producing ~40 issue flags per order (missing /
unordered / after-delivery events, missing flight, POD, address fields, …)
defined in `backend/app/carrier_config.py` alongside each carrier's
delivery/cancellation event vocabulary. Transport mode is read from
`etl.shipment.modeoftransportation` (not inferred from flight-number presence,
which was circular — an Air order missing its flight number was classified
Road, suppressing the very flag that should fire). A **mode-mismatch** flag
catches orders marked Road that carry air indicators (airport IATA / flight
details) with no flight number — likely mislabelled; the shipment detail page
raises the same flag from the GPS speed/ghost inference. Results group into a per-carrier
issue tracker; select issues and generate the carrier email — editable
template (to/cc/subject/intro/signature, persisted locally), HTML preview,
**.eml download** (opens in Outlook as an unsent draft via `X-Unsent`),
copy-HTML, and CSV export of the raw flags. Sequence-related observations
(missing / after-delivery / out-of-order) name the **specific carrier events**
involved — a set-based generalization of the ops team's per-order check — so
the carrier sees exactly which events to fix, not just a generic category.

### Injection-risk triage (`/api/ops/injection-risk`, Ops → Injection risk)

The RLT deadline board. Active shipments are ranked by **slack** — the gap
between the projected delivery ETA and the injection deadline
(`injectiondate` + `injectiontime`) — and cross-checked against **vial
expiry**. Critical when the ETA lands after the deadline or after the vial
expires (or the injection time has already passed undelivered), serious under
12 h slack, watch under 24 h. Most-urgent first, so ops clears the top of the
list. One bounded, cached query over `etl.shipment`.

### Milestone dwell time (`/api/analytics/dwell`, Analytics)

Replays recent carrier events against the milestone maps and reports the
**average time-in-stage** for each transition (Pickup→Departed, airport dwell,
flight, recovery, delivery drive), plus each carrier's end-to-end event span —
so systemic bottlenecks (a carrier sitting 9 h at the airport) surface for the
carrier conversation. Windowed, bounded, cached.

### Inbound feed health (`/api/feeds/health`)

Every inbound/reject table is watched for **silence and irregular volume**:
last row received (unbounded MAX), rows in the last 24 h vs a 14-day daily
median (zero-filled), per-feed max-gap thresholds (Sensitech 6 h, carrier
12 h, ROME/3A GEST2 24 h, full-loads 36 h). Flags: `silent`
(serious; critical past 2× the gap), `low_volume` (< 30 % of median),
`volume_spike`, `reject_spike` (reject tables are only flagged when they
*spike* — a quiet reject feed is good). A missing/unreadable table reports
`query_error` instead of breaking the panel.

### Overdue-injection RCA (`/api/ops/stale-injections`)

Set-based (5 queries for the whole list, no N+1). Verdicts, in priority order:
`cancelled_upstream` → `delivered_not_closed` → `arrived_no_pod` (last valid
fix inside geofence; `dist_threshold` or `DEFAULT_GEOFENCE_KM`) →
`gps_lost_in_transit` → `carrier_silent` / `no_sensitech_data` /
`never_departed` → `unexplained`.

---

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | app + DB + airport-data status |
| `GET /api/kpis` | one-pass KPI aggregates + flag counts + reject counts |
| `GET /api/feeds/health` | per-inbound-table silence / volume anomaly monitor |
| `GET /api/kpis/alerts` | alert-title breakdown from `alertstitle` |
| `GET /api/shipments` | paginated list, filters, inline flag booleans; `injection_from`/`injection_to` window (UI defaults to last 15 days) |
| `GET /api/kpis/injections` | today/tomorrow/future dose status, on-time/late, air-road split |
| `GET /api/analytics/carriers` | per-carrier performance: on-time %, transit time, cancel/issue rates |
| `GET /api/analytics/overview` | status distribution, mode/region/product volume, top lanes, weekly trend |
| `GET /api/ops/injection-risk` | active shipments ranked by slack (ETA vs injection deadline, vial expiry) |
| `GET /api/analytics/dwell` | avg time-in-stage per milestone transition + carrier end-to-end span |
| `POST /api/reports/carrier-issues` | on-demand carrier data-quality report (never auto-fetched) |
| `POST /api/reports/carrier-issues/email` | carrier email draft: HTML + .eml (X-Unsent) |
| `GET /api/shipments/filters` | dropdown values |
| `GET /api/shipments/{tn}/detail` | full row + issues + source traces + RCA + related orders (`?so=` to pick one) |
| `GET /api/shipments/{tn}/pings` | pings merged & deduped across all SOs on the tracking number |
| `GET /api/shipments/{tn}/milestones` | per-SO raw events + sequence validation + expected ladder (`?so=`) |
| `GET /api/shipments/{tn}/lifecycle` | data-provenance: when each source (ROME, 3A GEST2 full-load/incremental, carrier, Sensitech) delivered data |
| `GET /api/ops/data-quality?flag=` | flagged shipments + upstream probes |
| `GET /api/ops/sequence-violations` | recent orders replayed against maps |
| `GET /api/ops/stale-injections` | overdue shipments with RCA verdicts |
| `GET /api/ops/rejects?source=rome\|carrier\|sensitech` | reject feeds, grouped by error |

`{tn}` accepts the Sensitech tracking number **or** a sales order number.
One tracking number can carry several sales orders — the detail page shows a
sales-order switcher and the GPS trail is shared across the group.

**Caching**: aggregate endpoints are served from an in-process TTL cache
(KPIs/alerts 60 s, ops lists 60–120 s, feed health 120 s, filter values
5 min) with per-key locks, so any number of open dashboards costs the DB one
query burst per TTL. Per-shipment endpoints are always fresh.

## Safety & performance notes

- **Read-only by construction**: `default_transaction_read_only=on` +
  `statement_timeout` on every pooled connection; the app only issues SELECTs.
- **Query shape**: list/KPI pages are single-pass over `etl.shipment` with
  inline CASE flags; ops drill-downs use `= ANY($1::text[])` batches and
  `LATERAL EXISTS` probes; everything is LIMIT-bounded.
- Blank checks cast via `::text`, so they tolerate any column type. Date
  logic (`injectiondate::date`, `lastupdateddt::timestamp`) assumes ISO-ish
  values — if a real column carries a non-castable format, adjust the one
  expression in `backend/app/analysis/quality.py`.
- Terminal-state detection (delivered/cancelled) is heuristic over status
  strings — tune `DELIVERED_SQL` / `CANCELLED_SQL` in `quality.py` if your
  status vocabulary differs.
- Recommended supporting indexes (create if missing, they cost nothing to
  check): `carrier_inbound(salesordernumber)`,
  `sensitech_inbound_trip(salesordernumber, device_date_time)`,
  `rome_inbound_orders(salesordernumber)`, reject tables on
  `(audit_timestamp)` and `(salesordernumber)`.

## Config (`backend/.env`)

| Var | Default | Meaning |
|---|---|---|
| `DB_*` | — | RDS connection |
| `ACTIVE_WINDOW_DAYS` | 7 | closed shipments stay in KPI scope this long |
| `GPS_STALE_HOURS` | 4 | flag threshold for `gps_stale` |
| `GHOST_MAX_SPEED_KMH` | 1100 | teleport threshold |
| `DEFAULT_GEOFENCE_KM` | 1.0 | fallback when `dist_threshold` is blank |
