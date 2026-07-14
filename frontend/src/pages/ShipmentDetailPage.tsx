import { ReactNode, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Dict, fmt, PingsResponse } from "../api";
import {
  ErrorBox, IssueChips, Panel, SEV_COLOR, SEV_ICON, SeverityBadge, Spinner, useApi,
} from "../components/ui";
import ShipmentMap from "../components/ShipmentMap";

const enc = encodeURIComponent;

export default function ShipmentDetailPage() {
  const { tracking = "" } = useParams();
  const [so, setSo] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-3">
      {/* ---- header --------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-sm text-s1 hover:underline">← Back</Link>
        <h1 className="text-lg font-semibold tracking-tight">{fmt.text(s.trackingnumber ?? tracking)}</h1>
        {riskLabel && <SeverityBadge severity={riskSev} label={String(riskLabel)} />}
        <span className="ml-auto text-xs text-ink-3">
          Last updated: {fmt.dt(s.lastupdateddt)}
          {fmt.ago(s.lastupdateddt) && <> · {fmt.ago(s.lastupdateddt)}</>}
        </span>
      </div>

      {/* ---- alert banners --------------------------------------------------- */}
      <Banners s={s} issues={issues} rca={rca} pings={pings.data ?? null} />

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
      {related.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-3">
            {related.length} sales orders on this tracking number:
          </span>
          {related.map((o) => {
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
          ) : pings.data!.pings.length === 0 && pings.data!.destination.lat == null ? (
            <div className="py-6 text-sm text-ink-3">
              No Sensitech pings and no destination coordinates — nothing to plot.
            </div>
          ) : (
            <>
              <div className="relative">
                <ShipmentMap data={pings.data!} />
                <TripStatsCard s={s} pings={pings.data!} />
              </div>
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
  for (const i of issues) {
    if (banners.length >= 4) break;
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
  const phases = ladder.length
    ? ladder.map((l: Dict) => l.ui_milestone as string)
    : [...byUi.keys()];
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
