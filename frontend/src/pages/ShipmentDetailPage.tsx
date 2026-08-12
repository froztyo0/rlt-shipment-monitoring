import { ReactNode, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Dict, fmt, haversineKm, parseTs, Ping, PingsResponse } from "../api";
import {
  ErrorBox, IssueChips, Panel, SEV_COLOR, SEV_ICON, SeverityBadge, Spinner, useApi,
} from "../components/ui";
import { Donut } from "../components/charts";
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
  // no keepPrevious: on an SO switch we must never show the previous order's
  // dose numbers against the newly-selected order (they are clinically labelled).
  const dose = useApi<Dict>(
    () => api(`/api/shipments/${enc(tracking)}/dose`, so ? { so } : undefined),
    [tracking, so]
  );

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
    <div className="flex flex-col gap-4">
      {/* ---- page header --------------------------------------------------- */}
      <div className="rounded-lg border border-edge bg-surface-1 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link to="/" className="text-sm text-s1 hover:underline">← Back</Link>
          <h1 className="tnum text-xl font-semibold tracking-tight">{fmt.text(s.trackingnumber ?? tracking)}</h1>
          <span className="rounded-full px-2.5 py-0.5 text-xs font-medium"
            style={{ background: `color-mix(in srgb, ${SEV_COLOR[status.sev]} 16%, transparent)`, color: "var(--text-primary)" }}>
            {status.label}
          </span>
          {riskLabel && <SeverityBadge severity={riskSev} label={`risk: ${riskLabel}`} />}
          {s.product && (
            <span className="rounded border border-edge px-2 py-0.5 text-xs font-medium text-ink-2">
              {fmt.text(s.product)}
            </span>
          )}
          <span className="ml-auto text-xs text-ink-3">
            Updated {fmt.ago(s.lastupdateddt) ?? fmt.dt(s.lastupdateddt)}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <MetaItem label="Sales order" value={fmt.text(s.salesordernumber)} />
          {s.carrier && <MetaItem label="Carrier" value={fmt.text(s.carrier)} />}
          <MetaItem label="Mode" value={fmt.text(s.modeoftransportation)} />
          {s.region && <MetaItem label="Region" value={fmt.text(s.region)} />}
          {s.destinationname && <MetaItem label="Destination" value={fmt.text(s.destinationname)} />}
          {s.account && <MetaItem label="Account" value={fmt.text(s.account)} />}
        </div>
        {related.filter((o) => o.salesordernumber).length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-grid pt-2.5">
            <span className="text-[11px] uppercase tracking-wide text-ink-3">
              {related.filter((o) => o.salesordernumber).length} orders on this trip:
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
      </div>

      {/* ---- shipment KPI strip --------------------------------------------- */}
      <KpiStrip s={s} pings={pings.data ?? null} status={status.label} />

      {/* ---- alert banners --------------------------------------------------- */}
      <Banners s={s} issues={issues} rca={rca} pings={pings.data ?? null} />

      {/* ---- milestone progress stepper ------------------------------------- */}
      {miles.data && <MilestoneStepper data={miles.data} />}

      {/* ---- decay & dose intelligence --------------------------------------- */}
      {dose.data && dose.data.has_dose && <DosePanel d={dose.data} />}
      {dose.data && !dose.data.has_dose && dose.data.reason && (
        <div className="rounded-lg border border-edge bg-surface-1 px-4 py-2.5 text-xs text-ink-3">
          <span className="font-medium text-ink-2">Decay &amp; dose intelligence</span> — {String(dose.data.reason)}
          {dose.data.isotope && (
            <span className="text-ink-3"> ({String(dose.data.isotope)}, t½ {fmt.num(
              Math.round(Number(dose.data.half_life_hours) / 24 * 100) / 100)} d)</span>
          )}
        </div>
      )}

      {/* ---- order details (full width) -------------------------------------- */}
      <OrderDetails s={s} />

      {/* ---- map + analytics (left) · order details + milestones (right) ------ */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
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
          {pings.data && pings.data.pings.length > 0 && (
            <Panel title="GPS trip analytics">
              <GpsAnalytics pings={pings.data} />
            </Panel>
          )}
        </div>

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

/* compact "label value" pair for the header meta line */
function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-ink-3">{label}</span>
      <span className="font-medium text-ink-2">{value}</span>
    </span>
  );
}

/* consolidated order-details card (full width): route on the left, the order /
   dose spec grid on the right — replaces the old journey strip + dose-facts bar. */
function OrderDetails({ s }: { s: Dict }) {
  return (
    <Panel title="Order details">
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(220px,1.1fr)_2.9fr]">
        {/* route */}
        <div className="flex flex-col gap-1.5 text-sm md:border-r md:border-grid md:pr-6">
          <span className="flex items-baseline gap-2">
            <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--series-4)" }} />
            <span className="min-w-0">
              <span className="block text-[11px] uppercase tracking-wide text-ink-3">Origin</span>
              {fmt.text(s.origin)}
            </span>
          </span>
          <span className="ml-[3px] h-4 w-px bg-baseline" />
          <span className="flex items-baseline gap-2">
            <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--series-6)" }} />
            <span className="min-w-0">
              <span className="block text-[11px] uppercase tracking-wide text-ink-3">Destination</span>
              {fmt.text(s.destinationname)}
              {s.destinationaddress && (
                <span className="block text-xs text-ink-3">{s.destinationaddress}</span>
              )}
            </span>
          </span>
        </div>
        {/* spec grid */}
        <div className="grid grid-cols-2 gap-x-5 gap-y-3.5 text-sm sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Carrier">
            {s.carrier
              ? <span className="rounded border border-edge px-1.5 py-0.5 text-xs font-medium">{s.carrier}</span>
              : "—"}
          </Fact>
          <Fact label="Order type">{fmt.text(s.ordertype)}</Fact>
          <Fact label="Mode">
            {fmt.text(s.modeoftransportation)}
            {s.flightnumber && <span className="block text-xs text-ink-3">flight {s.flightnumber}</span>}
          </Fact>
          <Fact label="Planned delivery">
            {fmt.date(s.planneddeliverydate)} {s.planneddeliverytime ?? ""}
            {Number(s.totallegs) > 1 && (
              <span className="block text-xs text-ink-3">leg {s.currentleg ?? "?"} of {s.totallegs}</span>
            )}
          </Fact>
          <Fact label="Product">{fmt.text(s.product)}</Fact>
          <Fact label="Batch #">{fmt.text(s.batchnumber)}</Fact>
          <Fact label="Vial ID">{fmt.text(s.vialid)}</Fact>
          <Fact label="Planned injection">{fmt.date(s.injectiondate)} {s.injectiontime ?? ""}</Fact>
          <Fact label="Dose status">{fmt.text(s.dosestatus)}</Fact>
          <Fact label="Carrier tracking">{fmt.text(s.carriertrackingnumber)}</Fact>
        </div>
      </div>
    </Panel>
  );
}

/* =========================================================================== */
/* Decay & dose intelligence — radioactive-decay model of the delivered dose.
   All physics is deterministic (A(t) = A0·2^(−(t−t0)/t½)); the inputs are the
   batch activity columns. No data or schema change. */

const VERDICT_TONE: Record<string, string> = {
  underdosed: "critical",
  will_underdose: "serious",
  pre_window: "info",
  in_window: "good",
};

function DosePanel({ d }: { d: Dict }) {
  const tone = VERDICT_TONE[d.verdict] ?? "info";
  const color = SEV_COLOR[tone];
  const nowPct = Number(d.activity_now_pct);
  const etaPct = d.activity_at_eta_pct == null ? null : Number(d.activity_at_eta_pct);
  const marginH = Number(d.decay_margin_hours);
  const marginColor = marginH < 0 ? SEV_COLOR.critical : marginH < 12 ? SEV_COLOR.warning : undefined;

  return (
    <Panel
      title="Decay & dose intelligence"
      right={
        <span className="flex items-center gap-2 text-xs text-ink-3">
          <span className="rounded border border-edge px-1.5 py-0.5 font-medium">{d.isotope}</span>
          t½ {fmt.num(Math.round(Number(d.half_life_hours) / 24 * 100) / 100)} d
        </span>
      }
    >
      <div className="grid items-center gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
        <ActivityGauge d={d} color={color} />
        <div className="flex min-w-0 flex-col gap-3">
          <div className="rounded-md px-3 py-2 text-sm font-medium"
               style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color: "var(--text-primary)" }}>
            <span style={{ color }}>{SEV_ICON[tone]}</span> {d.verdict_label}
          </div>
          <DecayCurve d={d} color={color} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5 border-t border-grid pt-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Prescribed">
          {fmt.num(d.prescribed_gbq)} GBq
          <span className="block text-xs text-ink-3">{fmt.num(d.prescribed_mci)} mCi</span>
        </Fact>
        <Fact label="Activity now">
          <span style={{ color }}>{fmt.num(nowPct)}%</span>
          <span className="block text-xs text-ink-3">{fmt.num(d.activity_now_mbq)} MBq</span>
        </Fact>
        <Fact label="Activity at ETA">
          {etaPct == null ? "—" : <span>{fmt.num(etaPct)}%</span>}
          <span className="block text-xs text-ink-3">{d.eta ? fmt.dt(d.eta) : "no ETA"}</span>
        </Fact>
        <Fact label="Usable window closes">
          {fmt.dt(d.usable_until)}
          <span className="block text-xs text-ink-3" style={marginColor ? { color: marginColor } : undefined}>
            {marginH < 0 ? `${fmt.num(Math.abs(marginH))} h ago` : `in ${fmt.num(marginH)} h`}
          </span>
        </Fact>
        <Fact label="Calibrated for">
          {fmt.dt(d.calibration_time)}
          <span className="block text-xs text-ink-3">injection time</span>
        </Fact>
        <Fact label="Vial expiry">
          {d.vial_expiry ? fmt.dt(d.vial_expiry) : "—"}
          <span className="block text-xs text-ink-3">
            batch {fmt.text(d.batch_no)}{d.volume_ml ? ` · ${fmt.num(d.volume_ml)} mL` : ""}
          </span>
        </Fact>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        Vial is calibrated to the prescribed activity at the scheduled injection time; activity then follows
        A(t) = A₀·2^(−(t−t₀)/t½). Usable band is ±{Math.round(Number(d.tolerance) * 100)}% of prescribed —
        below it the dose is likely wasted. Deterministic decay physics over existing batch activity columns.
      </p>
    </Panel>
  );
}

/* radial activity gauge: current activity as % of prescribed, with the usable
   90–110% target zone marked by ticks. Colour follows the verdict. */
function ActivityGauge({ d, color }: { d: Dict; color: string }) {
  const pct = Number(d.activity_now_pct);
  const tolPct = Number(d.tolerance) * 100;
  const lowPct = 100 - tolPct, highPct = 100 + tolPct;
  const maxPct = Math.max(130, Math.ceil((pct + 8) / 10) * 10);
  const SIZE = 210, cx = SIZE / 2, cy = SIZE / 2, r = 84, sw = 16;
  const START = 135, SWEEP = 270;
  const frac = (p: number) => Math.max(0, Math.min(1, p / maxPct));
  const ang = (p: number) => (START + frac(p) * SWEEP) * Math.PI / 180;
  const arc = (p0: number, p1: number) => {
    const a0 = ang(p0), a1 = ang(p1);
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = (frac(p1) - frac(p0)) * SWEEP > 180 ? 1 : 0;
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const tick = (p: number) => {
    const a = ang(p), ri = r - sw / 2 - 2, ro = r + sw / 2 + 2;
    return { x1: cx + ri * Math.cos(a), y1: cy + ri * Math.sin(a), x2: cx + ro * Math.cos(a), y2: cy + ro * Math.sin(a) };
  };
  const na = ang(pct), nx = cx + r * Math.cos(na), ny = cy + r * Math.sin(na);
  const lo = tick(lowPct), hi = tick(highPct);

  return (
    <div className="relative mx-auto" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <path d={arc(0, maxPct)} fill="none" stroke="var(--grid)" strokeOpacity={0.55} strokeWidth={sw} strokeLinecap="round" />
        <path d={arc(lowPct, highPct)} fill="none" stroke={SEV_COLOR.good} strokeOpacity={0.28} strokeWidth={sw} />
        <path d={arc(0, pct)} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        <line x1={lo.x1} y1={lo.y1} x2={lo.x2} y2={lo.y2} stroke={SEV_COLOR.good} strokeWidth={2.5} strokeLinecap="round" />
        <line x1={hi.x1} y1={hi.y1} x2={hi.x2} y2={hi.y2} stroke={SEV_COLOR.good} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={nx} cy={ny} r={6} fill="var(--surface-1)" stroke={color} strokeWidth={3} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="tnum text-[34px] font-semibold leading-none" style={{ color }}>{fmt.num(pct)}%</span>
        <span className="mt-1 text-[11px] text-ink-3">of prescribed</span>
        <span className="tnum mt-1.5 text-sm text-ink-2">{fmt.num(d.activity_now_mbq)} MBq</span>
        <span className="mt-0.5 text-[10px] text-ink-3">
          usable {fmt.num(Math.round(lowPct))}–{fmt.num(Math.round(highPct))}%
        </span>
      </div>
    </div>
  );
}

/* decay curve over time with the usable band, prescribed reference, and the
   injection / now / ETA / window-close markers laid on the same axis. */
function DecayCurve({ d, color }: { d: Dict; color: string }) {
  const pts: { t: number; mbq: number }[] = (d.curve ?? [])
    .map((p: Dict) => ({ t: parseTs(p.t)?.getTime() ?? NaN, mbq: Number(p.mbq) }))
    .filter((p: { t: number }) => !isNaN(p.t));
  if (pts.length < 2) return null;

  const W = 660, H = 200, padL = 6, padR = 6, padT = 14, padB = 10;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const a0 = Number(d.prescribed_mbq);
  const yMax = Math.max(a0 * (1 + Number(d.tolerance)) * 1.06, ...pts.map((p) => p.mbq));
  const x = (t: number) => padL + ((t - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - v / yMax) * (H - padT - padB);
  const cx = (t?: number | null) =>
    t == null ? null : Math.max(padL, Math.min(W - padR, x(t)));

  const line = pts.map((p, i) => `${i ? "L" : "M"} ${x(p.t).toFixed(1)} ${y(p.mbq).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(t1).toFixed(1)} ${y(0).toFixed(1)} L ${x(t0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const low = Number(d.usable_low_mbq), high = Number(d.usable_high_mbq);
  const cal = parseTs(d.calibration_time)?.getTime() ?? null;
  const now = parseTs(d.now)?.getTime() ?? null;
  const eta = parseTs(d.eta)?.getTime() ?? null;
  const until = parseTs(d.usable_until)?.getTime() ?? null;

  // "now" uses a neutral ink (not the verdict color): the curve line + area +
  // gauge already carry the verdict hue, and a verdict-coloured "now" collides
  // with the blue ETA marker in the common pre_window (info) state.
  const markers = [
    { t: cal, label: "injection", c: "var(--series-5)", dash: false },
    { t: until, label: "usable ends", c: SEV_COLOR.warning, dash: true },
    { t: eta, label: "ETA", c: "var(--series-1)", dash: false },
    { t: now, label: "now", c: "var(--text-primary)", dash: false },
  ].filter((m) => m.t != null);

  return (
    <div className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 230 }}>
        {/* usable activity band */}
        <rect x={padL} y={y(high)} width={W - padL - padR} height={Math.max(0, y(low) - y(high))}
              fill={SEV_COLOR.good} opacity={0.13} />
        <line x1={padL} x2={W - padR} y1={y(a0)} y2={y(a0)} stroke="var(--text-muted)"
              strokeOpacity={0.6} strokeDasharray="3 3" strokeWidth={1} />
        <path d={area} fill={color} opacity={0.08} />
        <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {markers.map((m) => {
          const mx = cx(m.t)!;
          return (
            <line key={m.label} x1={mx} x2={mx} y1={padT} y2={H - padB} stroke={m.c}
                  strokeWidth={m.label === "now" ? 2 : 1.25}
                  strokeDasharray={m.dash ? "4 3" : undefined} strokeOpacity={0.9} />
          );
        })}
        {now != null && (
          <circle cx={cx(now)!} cy={y(Number(d.activity_now_mbq))} r={4.5}
                  fill="var(--text-primary)" stroke="var(--surface-1)" strokeWidth={1.5} />
        )}
        {eta != null && d.activity_at_eta_mbq != null && (
          <circle cx={cx(eta)!} cy={y(Number(d.activity_at_eta_mbq))} r={4.5}
                  fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={1.5} />
        )}
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
        {markers.map((m) => (
          <span key={m.label} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: m.c }} />{m.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm" style={{ background: SEV_COLOR.good, opacity: 0.5 }} />usable band
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0 w-3 border-t border-dashed" style={{ borderColor: "var(--text-muted)" }} />prescribed
        </span>
      </div>
    </div>
  );
}

/* ---- GPS trip analytics (all derived from the fetched pings, no extra API) - */
const FLIGHT_KMH = 300;

function GpsAnalytics({ pings }: { pings: PingsResponse }) {
  const all = pings.pings;
  const cleanSpeeds = all
    .filter((p) => !p.ghost && p.speed_kmh != null)
    .map((p) => p.speed_kmh as number);

  // per-trip / per-device breakdown
  const groups = new Map<string, Ping[]>();
  for (const p of all) {
    const k = String(p.tripid || p.device || "—");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  const trips = [...groups.entries()].map(([id, ps]) => {
    const speeds = ps.filter((p) => !p.ghost && p.speed_kmh != null).map((p) => p.speed_kmh as number);
    const times = ps.map((p) => p.ts).filter(Boolean).sort() as string[];
    return {
      id,
      pings: ps.length,
      ghosts: ps.filter((p) => p.ghost).length,
      maxSpeed: speeds.length ? Math.max(...speeds) : null,
      avgSpeed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null,
      flight: speeds.some((v) => v > FLIGHT_KMH) || pings.flight_segments.length > 0,
      first: times[0], last: times[times.length - 1],
    };
  });

  const ghostReasons = (pings.summary?.ghost_reasons ?? {}) as Record<string, number>;
  const ghostData = Object.entries(ghostReasons).map(([k, v], i) => ({
    label: k.replaceAll("_", " "), value: Number(v),
    color: ["var(--status-critical)", "var(--series-8)", "var(--series-3)", "var(--series-7)", "var(--series-5)"][i % 5],
  }));

  return (
    <div className="flex flex-col gap-4">
      {cleanSpeeds.length >= 2 && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-ink-3">
            <span>Ground speed profile (km/h)</span>
            <span className="tnum">
              max {Math.round(Math.max(...cleanSpeeds))} · avg{" "}
              {Math.round(cleanSpeeds.reduce((a, b) => a + b, 0) / cleanSpeeds.length)}
            </span>
          </div>
          <SpeedProfile speeds={cleanSpeeds} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-baseline text-left text-xs text-ink-3">
                <th className="px-2 py-1">Trip / device</th>
                <th className="px-2 py-1 text-right">Pings</th>
                <th className="px-2 py-1 text-right">Ghosts</th>
                <th className="px-2 py-1 text-right">Max</th>
                <th className="px-2 py-1 text-right">Avg</th>
                <th className="px-2 py-1">Mode</th>
                <th className="px-2 py-1">Span</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr key={t.id} className="border-b border-grid">
                  <td className="whitespace-nowrap px-2 py-1.5 tnum font-medium">{t.id}</td>
                  <td className="tnum px-2 py-1.5 text-right">{t.pings}</td>
                  <td className="tnum px-2 py-1.5 text-right"
                    style={{ color: t.ghosts ? SEV_COLOR.critical : undefined }}>{t.ghosts}</td>
                  <td className="tnum px-2 py-1.5 text-right">{t.maxSpeed != null ? `${Math.round(t.maxSpeed)}` : "—"}</td>
                  <td className="tnum px-2 py-1.5 text-right">{t.avgSpeed != null ? `${Math.round(t.avgSpeed)}` : "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{t.flight ? "✈ air leg" : "▣ road"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 tnum text-ink-3">
                    {t.first ? `${fmt.dt(t.first)} → ${fmt.dt(t.last)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ghostData.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-ink-3">Ghost ping causes</div>
            <Donut data={ghostData} size={140} thickness={18} />
          </div>
        )}
      </div>
    </div>
  );
}

function SpeedProfile({ speeds }: { speeds: number[] }) {
  const w = 100, h = 26;
  const max = Math.max(1, ...speeds);
  const step = w / (speeds.length - 1);
  const pts = speeds.map((v, i) => `${(i * step).toFixed(2)},${(h - (v / max) * h).toFixed(2)}`);
  const area = `0,${h} ${pts.join(" ")} ${w},${h}`;
  const flightY = max > FLIGHT_KMH ? h - (FLIGHT_KMH / max) * h : null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-14 w-full">
      <polygon points={area} fill="var(--series-1)" opacity={0.12} />
      <polyline points={pts.join(" ")} fill="none" stroke="var(--series-1)" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
      {flightY != null && (
        <line x1={0} y1={flightY} x2={w} y2={flightY} stroke="var(--series-5)"
          strokeWidth={0.6} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
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
