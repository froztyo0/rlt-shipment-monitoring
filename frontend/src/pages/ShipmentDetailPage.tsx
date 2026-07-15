import { ReactNode, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Dict, fmt, haversineKm, parseTs, PingsResponse } from "../api";
import {
  ErrorBox, IssueChips, Panel, SEV_COLOR, SEV_ICON, SeverityBadge, Spinner, useApi,
} from "../components/ui";
import ShipmentMap, { MapLayers, plottable } from "../components/ShipmentMap";

const enc = encodeURIComponent;

function shipmentStatus(s: Dict): { label: string; sev: string } {
  const blob = `${s.currentmilestone ?? ""} ${s.routestatus ?? ""} ${s.dosestatus ?? ""}`.toLowerCase();
  if (/cancel/.test(blob)) return { label: "Cancelled", sev: "critical" };
  if (/deliver|complet/.test(blob) || s.actualdeliverytime) return { label: "Delivered", sev: "good" };
  if (/arriv/.test(blob)) return { label: "Arrived", sev: "info" };
  if (String(s.actualdeparted ?? "").trim()) return { label: "In transit", sev: "info" };
  return { label: "Not started", sev: "warning" };
}

export default function ShipmentDetailPage() {
  const { tracking = "" } = useParams();
  const [so, setSo] = useState<string | null>(null);
  const [mapLayers, setMapLayers] = useState<MapLayers>({
    trail: true, pings: true, ghosts: true, airports: true, planned: true,
  });
  const [scrub, setScrub] = useState<number | null>(null); // null = show all pings

  const detail = useApi<Dict>(
    () => api(`/api/shipments/${enc(tracking)}/detail`, so ? { so } : undefined),
    [tracking, so]
  );
  // pings belong to the whole trip — shared across sales orders, fetched once
  const pings = useApi<PingsResponse>(() => api(`/api/shipments/${enc(tracking)}/pings`), [tracking]);
  const miles = useApi<Dict>(
    () => api(`/api/shipments/${enc(tracking)}/milestones`, so ? { so } : undefined),
    [tracking, so]
  );
  const lifecycle = useApi<Dict>(() => api(`/api/shipments/${enc(tracking)}/lifecycle`), [tracking]);

  if (detail.loading) return <Spinner label="Loading shipment…" />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  const s: Dict = detail.data!.shipment;
  const issues: Dict[] = detail.data!.issues ?? [];
  const traces: Dict[] = detail.data!.field_traces ?? [];
  const rca: Dict | null = detail.data!.stale_injection_rca;
  const related: Dict[] = detail.data!.related_orders ?? [];

  const riskLabel = s.riskbucket || s.risk;
  const riskSev = /high|critical/i.test(String(riskLabel ?? "")) ? "critical"
    : /med/i.test(String(riskLabel ?? "")) ? "warning" : "info";
  const status = shipmentStatus(s);

  return (
    <div className="flex flex-col gap-3">
      {/* ---- header --------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-sm text-s1 hover:underline">← Back</Link>
        <h1 className="tnum text-lg font-semibold tracking-tight">{fmt.text(s.trackingnumber ?? tracking)}</h1>
        <span className="rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ background: `color-mix(in srgb, ${SEV_COLOR[status.sev]} 16%, transparent)`, color: "var(--text-primary)" }}>
          {status.label}
        </span>
        {riskLabel && <SeverityBadge severity={riskSev} label={`risk: ${riskLabel}`} />}
        <span className="text-xs text-ink-3">SO {fmt.text(s.salesordernumber)}</span>
        <span className="ml-auto text-xs text-ink-3">
          Updated {fmt.ago(s.lastupdateddt) ?? fmt.dt(s.lastupdateddt)}
        </span>
      </div>

      {/* ---- shipment KPI strip --------------------------------------------- */}
      <KpiStrip s={s} pings={pings.data ?? null} status={status.label} />

      {/* ---- alert banners --------------------------------------------------- */}
      <Banners s={s} issues={issues} rca={rca} pings={pings.data ?? null} />

      {/* ---- milestone progress stepper ------------------------------------- */}
      {miles.data && <MilestoneStepper data={miles.data} />}

      {/* ---- journey strip --------------------------------------------------- */}
      <div className="rounded-lg border border-edge bg-surface-1 px-4 py-3">
        <div className="grid gap-3 text-sm md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-1.5">
            <span className="flex items-baseline gap-2">
              <span className="mt-[3px] h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--series-4)" }} />
              <span>
                <span className="text-[11px] uppercase tracking-wide text-ink-3">Origin&nbsp;&nbsp;</span>
                {fmt.text(s.origin)}
              </span>
            </span>
            <span className="ml-[3px] h-3 w-px bg-baseline" />
            <span className="flex items-baseline gap-2">
              <span className="mt-[3px] h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--series-6)" }} />
              <span>
                <span className="text-[11px] uppercase tracking-wide text-ink-3">Destination&nbsp;&nbsp;</span>
                {fmt.text(s.destinationname)}
                {s.destinationaddress && (
                  <span className="block text-xs text-ink-3">{s.destinationaddress}</span>
                )}
              </span>
            </span>
          </div>
          <Fact label="Carrier / Order type">
            <span className="flex flex-wrap items-center gap-1.5">
              {s.carrier ? (
                <span className="rounded border border-edge px-1.5 py-0.5 text-xs font-medium">{s.carrier}</span>
              ) : "—"}
              <span className="text-ink-2">{fmt.text(s.ordertype)}</span>
            </span>
          </Fact>
          <Fact label="Mode of transport">
            {fmt.text(s.modeoftransportation)}
            {s.flightnumber && <span className="block text-xs text-ink-3">flight {s.flightnumber}</span>}
          </Fact>
          <Fact label="Planned delivery">
            {fmt.date(s.planneddeliverydate)} {s.planneddeliverytime ?? ""}
            {Number(s.totallegs) > 1 && (
              <span className="block text-xs text-ink-3">leg {s.currentleg ?? "?"} of {s.totallegs}</span>
            )}
          </Fact>
        </div>
      </div>

      {/* ---- multi-SO switcher ----------------------------------------------- */}
      {related.filter((o) => o.salesordernumber).length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-3">
            {related.filter((o) => o.salesordernumber).length} sales orders on this tracking number:
          </span>
          {related.filter((o) => o.salesordernumber).map((o) => {
            const active = o.salesordernumber === s.salesordernumber;
            return (
              <button
                key={o.salesordernumber}
                onClick={() => setSo(String(o.salesordernumber))}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  active ? "border-s1 font-semibold" : "border-edge text-ink-2 hover:text-ink"
                }`}
                title={`${o.product ?? ""} · batch ${o.batchnumber ?? "—"} · ${o.currentmilestone ?? ""}`}
              >
                {o.salesordernumber}
                {o.issue_count > 0 && (
                  <span className="ml-1" style={{ color: SEV_COLOR.warning }}>◆{o.issue_count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ---- map (left) + milestones (right) ---------------------------------- */}
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Panel
          title="Route & GPS trail"
          right={
            pings.data ? (
              <span className="tnum text-xs text-ink-3">
                {pings.data.summary.total_pings} pings ·{" "}
                <span style={{ color: pings.data.summary.ghost_pings ? SEV_COLOR.critical : undefined }}>
                  {pings.data.summary.ghost_pings} ghost
                </span>{" "}
                · {pings.data.flight_segments.length} air leg(s)
              </span>
            ) : undefined
          }
        >
          {pings.loading ? (
            <Spinner label="Loading GPS pings…" />
          ) : pings.error ? (
            <ErrorBox error={pings.error} />
          ) : !pings.data!.pings.some((p) => plottable(p.lat, p.lon)) &&
            pings.data!.destination.lat == null && pings.data!.origin.lat == null ? (
            <div className="py-6 text-sm text-ink-3">
              No plottable GPS fixes and no origin/destination coordinates — nothing to map.
              {pings.data!.pings.length > 0 && (
                <> ({pings.data!.pings.length} ping(s) exist but carry no valid coordinates — see ghost details.)</>
              )}
            </div>
          ) : (
            <>
              <MapControls layers={mapLayers} setLayers={setMapLayers} data={pings.data!} />
              <div className="relative">
                <ShipmentMap data={pings.data!} layers={mapLayers} visibleCount={scrub}
                  delivered={status.label === "Delivered" || status.label === "Cancelled"}
                  roadMode={/road|ground|truck|drive|courier/i.test(String(s.modeoftransportation ?? ""))} />
                <TripStatsCard s={s} pings={pings.data!} />
              </div>
              <PingScrubber pings={pings.data!} scrub={scrub} setScrub={setScrub} />
              <MapLegend summary={pings.data!.summary} />
              {pings.data!.reported_flights.length > 0 && (
                <div className="mt-2 text-xs text-ink-2">
                  Carrier-reported flights:{" "}
                  {pings.data!.reported_flights
                    .map((f: Dict) => `${f.flightnumber ?? "?"} ${f.departure_iata ?? "?"}→${f.arrival_iata ?? "?"}`)
                    .join(" · ")}
                </div>
              )}
              {(pings.data!.summary.ghost_pings ?? 0) > 0 && <GhostTable pings={pings.data!} />}
            </>
          )}
        </Panel>

        <MilestonePanel miles={miles} so={String(s.salesordernumber ?? "")} />
      </div>

      {/* ---- order lifecycle / data provenance -------------------------------- */}
      <Panel title="Order lifecycle — where each event came from">
        {lifecycle.loading ? (
          <Spinner label="Tracing sources…" />
        ) : lifecycle.error ? (
          <ErrorBox error={lifecycle.error} />
        ) : (
          <LifecycleTimeline data={lifecycle.data!} />
        )}
      </Panel>

      {/* ---- dose facts (like the original bottom bar) ------------------------- */}
      <div className="grid grid-cols-2 gap-2.5 rounded-lg border border-edge bg-surface-1 p-3.5 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Product">{fmt.text(s.product)}</Fact>
        <Fact label="Batch #">{fmt.text(s.batchnumber)}</Fact>
        <Fact label="Vial ID">{fmt.text(s.vialid)}</Fact>
        <Fact label="Planned injection">
          {fmt.date(s.injectiondate)} {s.injectiontime ?? ""}
        </Fact>
        <Fact label="Sales order #">{fmt.text(s.salesordernumber)}</Fact>
        <Fact label="Dose status">{fmt.text(s.dosestatus)}</Fact>
      </div>

      {/* ---- RCA -------------------------------------------------------------- */}
      {rca && (
        <Panel title="⛔ Injection date passed — root cause analysis">
          <div className="mb-2 text-sm font-medium" style={{ color: SEV_COLOR.critical }}>
            {rca.verdict_label}
          </div>
          <ul className="flex flex-col gap-1 text-[13px]">
            {rca.evidence.map((e: Dict, i: number) => (
              <li key={i} className="flex gap-2">
                <span className="w-24 shrink-0 text-ink-3">{e.source}</span>
                <span className="text-ink-2">{e.detail}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* ---- source tracing ----------------------------------------------------- */}
      {traces.length > 0 && (
        <Panel title="Missing-field source tracing">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-baseline text-left text-xs text-ink-3">
                <th className="px-2 py-1">Field</th><th className="px-2 py-1">Verdict</th>
                <th className="px-2 py-1">Checked source</th><th className="px-2 py-1">Detail</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t, i) => (
                <tr key={i} className="border-b border-grid align-top">
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium">{t.field}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <SeverityBadge
                      severity={t.finding === "never_received" ? "critical" : t.finding === "rejected" ? "serious" : "warning"}
                      label={String(t.finding).replaceAll("_", " ")}
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{t.source}</td>
                  <td className="px-2 py-1.5 text-ink-2">{t.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {/* ---- everything else ----------------------------------------------------- */}
      <details className="rounded-lg border border-edge bg-surface-1 p-3.5">
        <summary className="cursor-pointer text-[13px] font-semibold tracking-tight">
          All shipment fields
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Region", s.region], ["Route", s.route], ["Route status", s.routestatus],
            ["Milestone", `${s.currentmilestone ?? "—"} (step ${s.currentmilestonestep ?? "?"})`],
            ["ETA", fmt.dt(s.etadeliverytime)], ["Departed", fmt.dt(s.actualdeparted)],
            ["Delivered", fmt.dt(s.actualdeliverytime)], ["Vial expiry", fmt.dt(s.vialexpirationtime)],
            ["Carrier tracking", s.carriertrackingnumber], ["Risk reason", s.risk_reason],
            ["Delay reason", s.delayreason], ["POD", s.podname || s.pod_receival_time],
            ["Production site", s.production_site], ["Account", s.account],
            ["Shipment type", s.shipmenttype], ["Geofence status", s.geofence_status],
            ["ROME status", s.rome_status], ["3A GEST2 status", s["3agest2_status"]],
            ["Carrier status", s.carrier_status], ["Alerts", s.alertstitle],
          ].map(([k, v]) => (
            <Fact key={String(k)} label={String(k)}>{fmt.text(v)}</Fact>
          ))}
        </div>
      </details>
    </div>
  );
}

/* =========================================================================== */

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="truncate" title={typeof children === "string" ? children : undefined}>
        {children}
      </div>
    </div>
  );
}

/* ---- shipment KPI strip ---------------------------------------------------- */
function KpiStrip({ s, pings, status }: { s: Dict; pings: PingsResponse | null; status: string }) {
  const now = Date.now();
  const dep = parseTs(s.actualdeparted);
  const del = parseTs(s.actualdeliverytime);
  const eta = parseTs(s.etadeliverytime);
  const planned = parseTs(s.planneddeliverydate);
  const inj = parseTs(s.injectiondate);

  const transitMs = dep ? (del ? del.getTime() : now) - dep.getTime() : null;
  const etaDeltaMs = eta && planned ? eta.getTime() - planned.getTime() : null;
  const injMs = inj ? inj.getTime() - now : null;

  // distance remaining: last valid ping → destination
  let distRemaining: number | null = null;
  if (pings && pings.destination.lat != null) {
    const last = [...pings.pings].reverse().find((p) => !p.ghost && plottable(p.lat, p.lon));
    if (last) distRemaining = haversineKm(last.lat!, last.lon!, pings.destination.lat, pings.destination.lon!);
  }

  const onTrack = etaDeltaMs == null ? null : etaDeltaMs <= 0;
  const delivered = status === "Delivered";

  const tiles: { label: string; value: ReactNode; tone?: string; sub?: string }[] = [
    { label: "Status", value: status,
      tone: status === "Delivered" ? "good" : status === "Cancelled" ? "critical" : "info" },
    { label: delivered ? "Total transit" : "Time in transit",
      value: fmt.dur(transitMs) ?? "—", sub: dep ? `since ${fmt.dt(s.actualdeparted)}` : "not departed" },
    { label: "ETA vs planned",
      value: etaDeltaMs == null ? "—" : (etaDeltaMs <= 0 ? "on time" : `+${fmt.dur(etaDeltaMs)}`),
      tone: onTrack == null ? undefined : onTrack ? "good" : "serious",
      sub: eta ? `ETA ${fmt.dt(s.etadeliverytime)}` : "no ETA" },
    { label: "Distance remaining",
      value: distRemaining == null ? "—" : distRemaining < 1 ? "at destination" : `${distRemaining.toFixed(0)} km`,
      tone: distRemaining != null && distRemaining < 1 ? "good" : undefined,
      sub: "last fix → destination" },
    { label: "Time to injection",
      value: injMs == null ? "—" : injMs < 0 ? `${fmt.dur(injMs)}` : fmt.dur(injMs),
      tone: injMs != null && injMs < 0 && !delivered ? "critical" : undefined,
      sub: injMs != null && injMs < 0 ? "overdue" : "remaining" },
    { label: "On-time projection",
      value: delivered ? (onTrack ? "delivered on time" : onTrack === false ? "delivered late" : "delivered")
        : onTrack == null ? "—" : onTrack ? "on track" : "at risk",
      tone: onTrack == null ? undefined : onTrack ? "good" : "serious" },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-edge bg-surface-1 px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide text-ink-3">{t.label}</div>
          <div className="mt-0.5 text-base font-semibold"
            style={{ color: t.tone ? SEV_COLOR[t.tone] : undefined }}>
            {t.value}
          </div>
          {t.sub && <div className="mt-0.5 truncate text-[11px] text-ink-3" title={t.sub}>{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/* ---- milestone progress stepper (horizontal journey) ----------------------- */
function MilestoneStepper({ data }: { data: Dict }) {
  const events: Dict[] = (data.raw_events ?? []).filter((e: Dict) => e.mapped);
  const ladder: Dict[] = data.expected_ladder ?? [];
  const firstByUi = new Map<string, string>(); // ui_milestone -> earliest event ts
  for (const e of events) {
    if (!e.ui_milestone || !e.eventtimestamp) continue;
    const prev = firstByUi.get(e.ui_milestone);
    if (!prev || e.eventtimestamp < prev) firstByUi.set(e.ui_milestone, e.eventtimestamp);
  }
  const cancelled = events.some((e: Dict) => e.flag === 0);
  const observed = [...new Set(events.map((e: Dict) => e.ui_milestone).filter(Boolean))];
  const phases: string[] = ladder.length ? ladder.map((l: Dict) => l.ui_milestone as string) : observed;
  if (!phases.length) {
    return (
      <div className="rounded-lg border border-edge bg-surface-1 px-4 py-3 text-[13px] text-ink-3">
        No carrier milestones received for this order yet.
      </div>
    );
  }
  let lastDone = -1;
  phases.forEach((p, i) => { if (firstByUi.has(p)) lastDone = i; });

  return (
    <div className="rounded-lg border border-edge bg-surface-1 px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px] font-semibold tracking-tight">Journey</span>
        <span className="text-xs text-ink-3">{data.mode} · {data.carrier ?? "carrier"}</span>
        {cancelled && <SeverityBadge severity="critical" label="cancellation received" />}
      </div>
      <div className="flex items-start overflow-x-auto pb-1">
        {phases.map((phase, i) => {
          const ts = firstByUi.get(phase);
          const done = !!ts;
          const current = i === lastDone;
          const dotColor = done ? (current ? "var(--series-1)" : "var(--status-good)") : "var(--baseline)";
          // time in this stage = next observed phase ts - this ts
          let stageMs: number | null = null;
          if (ts) {
            for (let j = i + 1; j < phases.length; j++) {
              const nts = firstByUi.get(phases[j]);
              if (nts) { stageMs = (parseTs(nts)?.getTime() ?? 0) - (parseTs(ts)?.getTime() ?? 0); break; }
            }
          }
          return (
            <div key={phase} className="flex min-w-[110px] flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <span className="h-0.5 flex-1" style={{ background: i === 0 ? "transparent" : (i <= lastDone ? "var(--status-good)" : "var(--grid)") }} />
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px]"
                  style={{ background: done ? dotColor : "var(--surface-1)", border: `2px solid ${dotColor}`, color: done ? "#fff" : "var(--text-muted)" }}>
                  {done ? (current ? "●" : "✓") : i + 1}
                </span>
                <span className="h-0.5 flex-1" style={{ background: i === phases.length - 1 ? "transparent" : (i < lastDone ? "var(--status-good)" : "var(--grid)") }} />
              </div>
              <div className={`mt-1.5 px-1 text-center text-[11px] leading-tight ${done ? "font-medium" : "text-ink-3"}`}>
                {phase}
              </div>
              <div className="mt-0.5 text-center text-[10px] tabular-nums text-ink-3">
                {ts ? fmt.dt(ts) : "—"}
              </div>
              {stageMs != null && stageMs > 0 && (
                <div className="text-center text-[10px] text-ink-3" title="time to next milestone">
                  +{fmt.dur(stageMs)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- map layer toggles ----------------------------------------------------- */
function MapControls({ layers, setLayers, data }: {
  layers: MapLayers; setLayers: (l: MapLayers) => void; data: PingsResponse;
}) {
  const opts: { key: keyof MapLayers; label: string; color: string; show: boolean }[] = [
    { key: "trail", label: "Actual trail", color: "var(--series-1)", show: true },
    { key: "planned", label: "Planned route", color: "var(--text-muted)", show: true },
    { key: "pings", label: "Ping markers", color: "var(--series-1)", show: true },
    { key: "ghosts", label: "Ghost pings", color: "var(--status-critical)", show: (data.summary.ghost_pings ?? 0) > 0 },
    { key: "airports", label: "Airports", color: "var(--series-5)", show: true },
  ];
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      {opts.filter((o) => o.show).map((o) => (
        <label key={o.key} className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={layers[o.key]}
            onChange={(e) => setLayers({ ...layers, [o.key]: e.target.checked })} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: o.color }} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/* ---- ping time scrubber ---------------------------------------------------- */
function PingScrubber({ pings, scrub, setScrub }: {
  pings: PingsResponse; scrub: number | null; setScrub: (n: number | null) => void;
}) {
  const clean = pings.pings.filter((p) => !p.ghost && plottable(p.lat, p.lon));
  const total = clean.length;
  if (total < 2) return null;
  const val = scrub ?? total;
  const current = clean[Math.min(total, Math.max(1, val)) - 1];
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-ink-2">
      <span className="whitespace-nowrap text-ink-3">Replay</span>
      <input
        type="range" min={1} max={total} value={val}
        onChange={(e) => setScrub(Number(e.target.value) === total ? null : Number(e.target.value))}
        className="flex-1 accent-[color:var(--series-1)]"
      />
      <span className="tnum whitespace-nowrap text-ink-3">
        {val}/{total}{current ? ` · ${fmt.dt(current.ts)}` : ""}
      </span>
      {scrub != null && (
        <button className="text-s1 hover:underline" onClick={() => setScrub(null)}>reset</button>
      )}
    </div>
  );
}

/* ---- order lifecycle / data-provenance timeline ---------------------------- */
function LifecycleTimeline({ data }: { data: Dict }) {
  const stages: Dict[] = data.stages ?? [];
  if (!stages.length) return <div className="text-sm text-ink-3">No source data found for this order.</div>;
  // overall received span for a subtle relative sense
  return (
    <div>
      <div className="mb-2 text-xs text-ink-3">
        Sales order(s): <span className="tnum">{(data.sales_orders ?? []).join(", ") || "—"}</span>
        {" "}· pipeline order, earliest → latest source
      </div>
      <ol className="relative ml-1 border-l border-baseline">
        {stages.map((st) => {
          const color = st.received ? (st.rejected_count ? "var(--status-serious)" : "var(--status-good)")
            : "var(--baseline)";
          return (
            <li key={st.key} className="relative mb-3 ml-4 last:mb-0">
              <span className="absolute -left-[22px] top-1 h-3 w-3 rounded-full border-2"
                style={{ background: st.received ? color : "var(--surface-1)", borderColor: color }} />
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[13px] ${st.received ? "font-medium" : "text-ink-3"}`}>{st.label}</span>
                {st.received ? (
                  <span className="tnum rounded-full border border-edge px-2 py-0.5 text-[11px] text-ink-2">
                    {st.count} row{st.count === 1 ? "" : "s"}
                  </span>
                ) : (
                  <SeverityBadge severity="warning" label="not received" />
                )}
                {st.rejected_count > 0 && (
                  <span title={st.reject_message ?? ""}>
                    <SeverityBadge severity="serious" label={`${st.rejected_count} rejected`} />
                  </span>
                )}
                <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-3">{st.ts_basis}</span>
              </div>
              {st.received && (
                <div className="mt-0.5 text-xs text-ink-3 tnum">
                  {st.first_ts === st.last_ts
                    ? fmt.dt(st.first_ts)
                    : <>first {fmt.dt(st.first_ts)} · last {fmt.dt(st.last_ts)}</>}
                </div>
              )}
              {st.rejected_count > 0 && st.reject_message && (
                <div className="mt-0.5 text-xs" style={{ color: "var(--status-serious)" }}>
                  ⚠ {String(st.reject_message).slice(0, 160)}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ---- alert banner strips (like the original red/amber bars) ---------------- */
function Banners({ s, issues, rca, pings }: { s: Dict; issues: Dict[]; rca: Dict | null; pings: PingsResponse | null }) {
  const banners: { severity: string; text: string }[] = [];

  if (rca) {
    banners.push({
      severity: "critical",
      text: `Shipment is at risk: injection date ${fmt.date(s.injectiondate)} has passed — ${rca.verdict_label}`,
    });
  }
  const gpsIssue = issues.find((i) => i.code === "gps_stale" || i.code === "no_sensitech_data");
  if (gpsIssue) {
    const lastPing = pings?.pings?.slice().reverse().find((p) => !p.ghost && p.address);
    const where = lastPing?.address ?? s.currentlocation ?? null;
    banners.push({
      severity: "serious",
      text:
        (where ? `The shipment was last seen at ${where}. ` : "") +
        `Last Sensitech update ${fmt.dt(s.lastgps)}` +
        (fmt.ago(s.lastgps) ? ` (${fmt.ago(s.lastgps)})` : "") + ".",
    });
  }
  // speed-logic transport-mode mismatch: GPS shows a flight but the shipment
  // is recorded as Road with no flight number → likely mislabelled mode
  const airLegs = pings?.flight_segments?.length ?? 0;
  const modeStr = String(s.modeoftransportation ?? "").toLowerCase();
  const looksAir = /air|flight/.test(modeStr) || String(s.transportmode_flight ?? "").trim() !== "";
  const flightMissing = String(s.flightnumber ?? "").trim() === "";
  if (airLegs > 0 && !looksAir && flightMissing) {
    banners.push({
      severity: "serious",
      text:
        `Air travel detected from GPS speed (${airLegs} inferred flight leg${airLegs === 1 ? "" : "s"}), ` +
        `but this shipment is recorded as “${s.modeoftransportation || "Road"}” with no flight number — ` +
        `likely a mislabelled transport mode. Confirm the mode and capture the flight details.`,
    });
  }
  for (const i of issues) {
    if (banners.length >= 5) break;
    if (i.severity === "critical" && i.code !== "stale_injection") {
      banners.push({ severity: "critical", text: `${i.label} — ${i.hint}` });
    }
  }
  const rest = issues.filter((i) => i.code !== "gps_stale");

  return (
    <div className="flex flex-col gap-1.5">
      {banners.map((b, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]"
          style={{
            borderColor: SEV_COLOR[b.severity],
            background: `color-mix(in srgb, ${SEV_COLOR[b.severity]} 8%, transparent)`,
          }}
        >
          <span style={{ color: SEV_COLOR[b.severity] }}>{SEV_ICON[b.severity]}</span>
          <span>{b.text}</span>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-1"><IssueChips issues={rest as any} max={8} /></div>
      )}
    </div>
  );
}

/* ---- floating stats card over the map (delta / departed / ETA / GPS) -------- */
function TripStatsCard({ s, pings }: { s: Dict; pings: PingsResponse }) {
  const rows: [string, ReactNode][] = [
    ["Delta", s.delta ?? "—"],
    ["Departed", fmt.dt(s.actualdeparted)],
    ["ETA delivery", fmt.dt(s.etadeliverytime)],
    ["Latest GPS ping", fmt.ago(pings.summary.last_ping ?? s.lastgps) ?? fmt.dt(s.lastgps)],
    ["Latest update", fmt.dt(s.lastupdateddt)],
    ["Distance", s.distance ? `${s.distance} km` : "—"],
  ];
  return (
    <div className="absolute left-3 top-3 z-[1000] w-52 rounded-md border border-edge bg-surface-1/95 p-3 shadow-md backdrop-blur">
      {rows.map(([k, v]) => (
        <div key={k} className="mb-2 last:mb-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-3">{k}</div>
          <div className="text-[13px] font-medium">{v}</div>
        </div>
      ))}
    </div>
  );
}

/* ---- right-hand milestone panel --------------------------------------------- */
function MilestonePanel({ miles, so }: { miles: { data: Dict | null; loading: boolean; error: unknown }; so: string }) {
  const [tab, setTab] = useState<"timeline" | "events" | "history">("timeline");
  const d = miles.data;
  const issueCount = d?.sequence_issues?.length ?? 0;
  return (
    <Panel
      title={`Milestones${d ? ` · ${d.mode}` : ""}${so ? ` · ${so}` : ""}`}
      right={
        d ? (
          issueCount > 0 ? (
            <SeverityBadge severity="serious" label={`${issueCount} issue(s)`} />
          ) : (
            <SeverityBadge severity="good" label="sequence OK" />
          )
        ) : undefined
      }
    >
      {miles.loading ? (
        <Spinner />
      ) : miles.error ? (
        <ErrorBox error={miles.error} />
      ) : (
        <>
          <div className="mb-3 flex gap-1 border-b border-edge">
            {([["timeline", "Timeline"], ["events", "Raw events"], ["history", "History"]] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium ${
                  tab === id ? "border-s1 text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "timeline" && <Timeline d={d!} />}
          {tab === "events" && <RawEvents d={d!} />}
          {tab === "history" && <History d={d!} />}
        </>
      )}
    </Panel>
  );
}

function Timeline({ d }: { d: Dict }) {
  const events: Dict[] = (d.raw_events ?? []).filter((e: Dict) => e.mapped);
  const ladder: Dict[] = d.expected_ladder ?? [];
  const byUi = new Map<string, Dict[]>();
  for (const e of events) {
    if (!e.ui_milestone) continue;
    if (!byUi.has(e.ui_milestone)) byUi.set(e.ui_milestone, []);
    byUi.get(e.ui_milestone)!.push(e);
  }
  const cancelled = events.filter((e: Dict) => e.flag === 0);
  // ladder order first, then any observed milestone the ladder doesn't know
  // about (mapping drift) — events must never silently vanish
  const ladderPhases = ladder.map((l: Dict) => l.ui_milestone as string);
  const extraPhases = [...byUi.keys()].filter((p) => !ladderPhases.includes(p));
  const phases = ladderPhases.length ? [...ladderPhases, ...extraPhases] : [...byUi.keys()];
  let lastDone = -1;
  phases.forEach((p, i) => { if (byUi.has(p)) lastDone = i; });

  if (events.length === 0) {
    return (
      <div className="text-[13px] text-ink-2">
        <p className="mb-2 rounded-md border border-edge bg-surface-0 px-2.5 py-2 text-xs text-ink-3">
          No updates have been received from the carrier for this sales order —
          nothing to place on the timeline. Check the Raw events tab / carrier
          rejects on the Ops page.
        </p>
        {(d.processed_milestones ?? []).length > 0 && <History d={d} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {cancelled.length > 0 && (
        <div className="mb-2 rounded-md border px-2.5 py-1.5 text-xs"
          style={{ borderColor: SEV_COLOR.critical, color: "var(--text-primary)" }}>
          <span style={{ color: SEV_COLOR.critical }}>⛔</span> Cancellation event received:{" "}
          {cancelled.map((e: Dict) => `${e.event} @ ${fmt.dt(e.eventtimestamp)}`).join(", ")}
        </div>
      )}
      <ol className="relative ml-1.5 border-l border-baseline">
        {phases.map((phase, i) => {
          const evs = byUi.get(phase) ?? [];
          const done = evs.length > 0;
          const current = i === lastDone;
          const hasIssue = evs.some((e: Dict) => e.issues?.length);
          const dotColor = done
            ? hasIssue ? SEV_COLOR.serious : SEV_COLOR.good
            : "var(--baseline)";
          return (
            <li key={phase} className="relative mb-4 ml-4 last:mb-1">
              <span
                className="absolute -left-[23.5px] top-0.5 h-3.5 w-3.5 rounded-full border-2"
                style={{
                  background: done ? dotColor : "var(--surface-1)",
                  borderColor: current ? "var(--series-1)" : dotColor,
                }}
              />
              <div className={`text-[13px] ${done ? "font-medium" : "text-ink-3"}`}>
                {phase}
                {current && done && (
                  <span className="ml-1.5 rounded bg-grid px-1 py-px text-[10px] text-ink-2">current</span>
                )}
              </div>
              {evs.map((e: Dict, j: number) => (
                <div key={j} className="mt-1 text-xs text-ink-2">
                  <span className="tnum text-ink-3">{fmt.dt(e.eventtimestamp)}</span>{" "}
                  · {e.event}
                  {e.event_description && (
                    <span className="text-ink-3"> — {String(e.event_description).slice(0, 70)}</span>
                  )}
                  {(e.issues ?? []).map((code: string) => (
                    <span key={code} className="ml-1.5">
                      <SeverityBadge
                        severity={code === "invalid_event" || code === "out_of_order" ? "serious" : "warning"}
                        label={code.replaceAll("_", " ")}
                      />
                    </span>
                  ))}
                </div>
              ))}
            </li>
          );
        })}
      </ol>
      {(d.raw_events ?? []).some((e: Dict) => !e.mapped) && (
        <div className="mt-1 text-xs" style={{ color: SEV_COLOR.serious }}>
          ▲ {(d.raw_events ?? []).filter((e: Dict) => !e.mapped).length} unmapped event(s) — see Raw events tab
        </div>
      )}
    </div>
  );
}

const STEP_LABELS = ["Cancelled", "Confirmed / Pickup", "Departed / At airport", "Flight departure", "Flight arrival / On road", "Delivered"];

function RawEvents({ d }: { d: Dict }) {
  const events: Dict[] = d.raw_events ?? [];
  const issues: Dict[] = d.sequence_issues ?? [];
  return (
    <div className="flex flex-col gap-2.5">
      {issues.length > 0 && (
        <div className="flex flex-col gap-1">
          {issues.map((it: Dict, i: number) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <SeverityBadge severity={it.severity} label={it.type.replaceAll("_", " ")} />
              <span className="text-ink-2">{it.detail}</span>
            </div>
          ))}
        </div>
      )}
      {events.length === 0 ? (
        <div className="text-xs text-ink-3">No raw carrier events for this sales order.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-baseline text-left text-ink-3">
              <th className="px-1.5 py-1">Time</th>
              <th className="px-1.5 py-1">Event</th>
              <th className="px-1.5 py-1">Step</th>
              <th className="px-1.5 py-1">✓</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e: Dict, i: number) => (
              <tr key={i} className="border-b border-grid align-top"
                style={e.issues?.length ? { background: "color-mix(in srgb, var(--status-serious) 7%, transparent)" } : undefined}>
                <td className="whitespace-nowrap px-1.5 py-1 tnum">{fmt.dt(e.eventtimestamp)}</td>
                <td className="px-1.5 py-1">
                  <span className="font-medium">{fmt.text(e.event)}</span>
                  <span className="block text-[11px] text-ink-3">{e.ui_milestone ?? "unmapped"}</span>
                </td>
                <td className="whitespace-nowrap px-1.5 py-1 tnum" title={e.flag != null ? STEP_LABELS[e.flag] : ""}>
                  {e.step ?? "—"}
                </td>
                <td className="px-1.5 py-1">
                  {e.issues?.length ? (
                    <span title={e.issues.join(", ")} style={{ color: SEV_COLOR.serious }}>▲</span>
                  ) : (
                    <span style={{ color: "var(--status-good)" }}>✓</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function History({ d }: { d: Dict }) {
  const rows: Dict[] = d.processed_milestones ?? [];
  if (!rows.length) return <div className="text-xs text-ink-3">No processed milestone history rows.</div>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-baseline text-left text-ink-3">
          <th className="px-1.5 py-1">Time</th>
          <th className="px-1.5 py-1">Milestone</th>
          <th className="px-1.5 py-1">Leg</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m: Dict, i: number) => (
          <tr key={i} className="border-b border-grid">
            <td className="whitespace-nowrap px-1.5 py-1 tnum">{fmt.dt(m.event_timestamp)}</td>
            <td className="px-1.5 py-1">
              {fmt.text(m.milestone)}
              <span className="block text-[11px] text-ink-3">{fmt.text(m.event)}</span>
            </td>
            <td className="whitespace-nowrap px-1.5 py-1 tnum">{m.currentleg ?? "—"}/{m.totallegs ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---- shared bits ------------------------------------------------------------- */
function MapLegend({ summary }: { summary: Dict }) {
  const items: [string, string][] = [
    ["var(--series-1)", "GPS ping"],
    ["var(--status-good)", "latest fix"],
    ["var(--status-critical)", "ghost ping"],
    ["var(--series-5)", "air leg / airport"],
    ["var(--series-4)", "origin"],
    ["var(--series-6)", "destination"],
  ];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-2">
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-edge" style={{ background: c }} />
          {l}
        </span>
      ))}
      {summary.ghost_reasons && Object.keys(summary.ghost_reasons).length > 0 && (
        <span className="text-ink-3">
          ghost causes: {Object.entries(summary.ghost_reasons).map(([k, v]) => `${k}×${v}`).join(", ")}
        </span>
      )}
    </div>
  );
}

function GhostTable({ pings }: { pings: PingsResponse }) {
  const ghosts = pings.pings.filter((p) => p.ghost);
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-ink-2">
        Ghost ping details ({ghosts.length})
      </summary>
      <table className="mt-1.5 w-full text-xs">
        <thead>
          <tr className="border-b border-baseline text-left text-ink-3">
            <th className="px-2 py-1">Time</th><th className="px-2 py-1">Lat / Lon</th>
            <th className="px-2 py-1">Speed</th><th className="px-2 py-1">Jump</th>
            <th className="px-2 py-1">Reasons</th>
          </tr>
        </thead>
        <tbody>
          {ghosts.map((g, i) => (
            <tr key={i} className="border-b border-grid">
              <td className="whitespace-nowrap px-2 py-1 tnum">{fmt.dt(g.ts)}</td>
              <td className="whitespace-nowrap px-2 py-1 tnum">{g.lat?.toFixed(4)}, {g.lon?.toFixed(4)}</td>
              <td className="whitespace-nowrap px-2 py-1 tnum">{g.speed_kmh != null ? `${g.speed_kmh} km/h` : "—"}</td>
              <td className="whitespace-nowrap px-2 py-1 tnum">{g.dist_km != null ? `${g.dist_km} km / ${g.gap_min} min` : "—"}</td>
              <td className="px-2 py-1" style={{ color: SEV_COLOR.critical }}>{g.reasons.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
