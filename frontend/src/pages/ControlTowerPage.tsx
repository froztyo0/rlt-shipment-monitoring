import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MapContainer, TileLayer, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { api, Dict, fmt, TTL } from "../api";
import { ErrorBox, KpiTile, Panel, SEV_COLOR, Spinner, useApi } from "../components/ui";
import { CalDay, CalendarHeatmap } from "../components/charts";

/* Control Tower — one fast page (single cached request) with all nine tower
   sections: fleet snapshot, the predict-the-miss action queue, exceptions,
   SLA/OTIF + dose-integrity, silent-feed watchtower, carrier scorecards,
   network concentration, injection calendar, and a geographic command map. */

const EXC_META: Record<string, { label: string; tone: string }> = {
  overdue: { label: "Injection overdue", tone: "critical" },
  gps_lost: { label: "GPS signal lost", tone: "serious" },
  missing_batch: { label: "Missing batch", tone: "serious" },
  no_eta: { label: "No carrier ETA", tone: "warning" },
  not_departed: { label: "Not departed", tone: "serious" },
  high_risk: { label: "High risk", tone: "critical" },
};

const HANDOVER_GROUPS = [
  { status: "new", label: "Open — needs pickup", tone: "critical" },
  { status: "ack", label: "In progress", tone: "info" },
  { status: "resolved", label: "Resolved this shift", tone: "good" },
] as const;

const tone = (score: number) => (score >= 1000 ? "critical" : score >= 400 ? "serious" : "warning");
const shipHref = (r: Dict) => `/shipment/${encodeURIComponent(String(r.trackingnumber || r.salesordernumber))}`;
const shipName = (r: Dict) => r.trackingnumber || `SO ${r.salesordernumber}`;

/* Client-side case store (localStorage) — ack / assign / SLA. The DB stays
   strictly read-only; case state lives only in the operator's browser. */
type CaseSnap = { name: string; href: string; reason: string };
type CaseState = { status: "new" | "ack" | "resolved"; owner: string; firstSeen: number; ackAt?: number; snap?: CaseSnap };
const CASE_KEY = "ct-cases-v1";

// clipboard that also works on non-secure origins (HTTP / embedded); resolves
// only on real success so the UI never falsely claims "copied".
function copyText(txt: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(txt);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      ok ? resolve() : reject(new Error("copy failed"));
    } catch (e) { reject(e); }
  });
}
const caseId = (r: Dict) => String(r.trackingnumber || r.salesordernumber);
const OWNERS = ["Me", "Carrier ops", "Site coord", "QA"];

function loadCases(): Record<string, CaseState> {
  try { return JSON.parse(localStorage.getItem(CASE_KEY) || "{}"); } catch { return {}; }
}
// SLA-to-acknowledge (minutes) by the most urgent reason on the case.
function slaMinutes(r: Dict): number {
  const rs: string[] = r.reasons ?? [];
  if (rs.some((x) => x.includes("deadline passed"))) return 60;
  if (rs.some((x) => x.includes("GPS silent"))) return 45;
  if (rs.some((x) => /injects in \d+h/.test(x))) return 120;
  if (rs.some((x) => x.includes("not yet departed"))) return 180;
  return 240;
}
const fmtMins = (m: number) => (Math.abs(m) >= 60 ? `${(Math.abs(m) / 60).toFixed(1)}h` : `${Math.round(Math.abs(m))}m`);

export default function ControlTowerPage() {
  const data = useApi<Dict>(() => api("/api/control-tower", undefined, { ttl: TTL.DEFAULT }), []);

  // ---- case management (client-side only; DB stays read-only) ----
  // All hooks stay ABOVE the early returns so the hook order never changes.
  const queue: Dict[] = data.data?.action_queue ?? [];
  const [cases, setCases] = useState<Record<string, CaseState>>(loadCases);
  const [, setTick] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const missing = queue.filter((r) => !cases[caseId(r)]);
    if (missing.length) {
      const nowMs = Date.now();
      const next = { ...cases };
      missing.forEach((r) => {
        next[caseId(r)] = {
          status: "new", owner: "", firstSeen: nowMs,
          snap: { name: shipName(r), href: shipHref(r), reason: (r.reasons ?? [])[0] ?? "" },
        };
      });
      setCases(next);
      try { localStorage.setItem(CASE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.map((r) => caseId(r)).join(",")]);

  const patchCase = (id: string, patch: Partial<CaseState>) => {
    setCases((prev) => {
      const cur = prev[id] ?? { status: "new" as const, owner: "", firstSeen: Date.now() };
      const next = { ...prev, [id]: { ...cur, ...patch } };
      try { localStorage.setItem(CASE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const now = Date.now();
  // The handover brief is grouped from the CASE STORE, not the live queue — so
  // a case that has been acknowledged/resolved still appears even after the
  // backend stops flagging its shipment (which is exactly when it's resolved).
  // "Open" stays queue-driven (only doses the backend is actively flagging).
  const queueIds = new Set(queue.map((r) => caseId(r)));
  type BriefItem = { id: string; name: string; href: string; reason: string; owner: string };
  const briefItems = (st: string): BriefItem[] => {
    const fromQueue: BriefItem[] = queue
      .filter((r) => (cases[caseId(r)]?.status ?? "new") === st)
      .map((r) => ({ id: caseId(r), name: shipName(r), href: shipHref(r), reason: (r.reasons ?? [])[0] ?? "", owner: cases[caseId(r)]?.owner ?? "" }));
    if (st === "new") return fromQueue;
    const fromStore: BriefItem[] = Object.entries(cases)
      .filter(([id, c]) => c.status === st && !queueIds.has(id))
      .map(([id, c]) => ({ id, name: c.snap?.name ?? id, href: c.snap?.href ?? `/shipment/${encodeURIComponent(id)}`, reason: c.snap?.reason ?? "", owner: c.owner }));
    return [...fromQueue, ...fromStore];
  };
  const openCount = briefItems("new").length;
  const ackCount = briefItems("ack").length;
  const resolvedCount = briefItems("resolved").length;
  const breachCount = queue.filter((r) => {
    const c = cases[caseId(r)];
    return (!c || c.status === "new") && (now - (c?.firstSeen ?? now)) / 60000 > slaMinutes(r);
  }).length;

  const copyBrief = () => {
    const line = (x: BriefItem, withOwner = false) =>
      `  • ${x.name} — ${x.reason}${withOwner && x.owner ? `  [${x.owner}]` : ""}`;
    const txt = [
      `RLT Control Tower — shift handover · ${new Date().toLocaleString()}`,
      ``,
      `OPEN — needs pickup (${briefItems("new").length}):`, ...briefItems("new").map((x) => line(x)),
      ``,
      `IN PROGRESS (${briefItems("ack").length}):`, ...briefItems("ack").map((x) => line(x, true)),
      ``,
      `RESOLVED THIS SHIFT (${briefItems("resolved").length}):`, ...briefItems("resolved").map((x) => line(x)),
    ].join("\n");
    copyText(txt)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); })
      .catch(() => { /* leave the button unchanged on failure */ });
  };

  if (data.loading) return <Spinner label="Building the command picture…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const f = d.fleet ?? {};
  const sla = d.sla ?? {};

  const calMax = Math.max(1, ...(d.calendar ?? []).map((c: Dict) => Number(c.total)));
  const calDays: CalDay[] = (d.calendar ?? []).map((c: Dict) => {
    const color = c.overdue > 0 ? "var(--status-critical)" : c.at_risk > 0 ? "var(--status-serious)" : "var(--series-1)";
    return {
      day: c.day,
      bg: `color-mix(in srgb, ${color} ${Math.round((c.total / calMax) * 66 + 16)}%, transparent)`,
      title: `${c.day}: ${c.total} injection${c.total === 1 ? "" : "s"}${c.overdue ? ` · ${c.overdue} overdue` : ""}${c.at_risk ? ` · ${c.at_risk} at-risk` : ""}`,
    };
  });
  const todayIso = new Date().toISOString().slice(0, 10);
  const dout: Dict = d.demand_outlook ?? {};
  const hasCap = Number(dout.capacity_per_day) > 0;   // false when there's no delivery history yet
  const dmax = Math.max(Number(dout.capacity_per_day) || 1, ...(dout.days ?? []).map((y: Dict) => Number(y.demand)), 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Control Tower</h1>
        <span className="text-xs text-ink-3">fleet command · injection window ±30 days</span>
        <span className="ml-auto text-xs text-ink-3">as of {fmt.dt(d.generated_at)} · ↻ Refresh for live</span>
      </div>

      {/* 1 — fleet snapshot */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="Active doses" value={fmt.num(f.active)} sub="un-injected, in play" />
        <KpiTile label="In transit" value={fmt.num(f.in_transit)} sub="departed" />
        <KpiTile label="At risk" value={fmt.num(f.at_risk)} tone={f.at_risk > 0 ? "serious" : "good"} sub="need eyes" />
        <KpiTile label="Overdue" value={fmt.num(f.overdue)} tone={f.overdue > 0 ? "critical" : "good"} sub="injection passed" />
        <KpiTile label="OTIF" value={sla.otif_pct == null ? "—" : `${sla.otif_pct}%`}
          tone={sla.otif_pct == null ? undefined : sla.otif_pct >= 90 ? "good" : sla.otif_pct >= 75 ? "warning" : "serious"}
          sub={`on-time-in-full · n=${sla.otif_n ?? 0}`} />
        <KpiTile label="Dose integrity" value={sla.dose_integrity_pct == null ? "—" : `${sla.dose_integrity_pct}%`}
          tone={sla.dose_integrity_pct == null ? undefined : sla.dose_integrity_pct >= 90 ? "good" : sla.dose_integrity_pct >= 75 ? "warning" : "critical"}
          sub="arrived still usable" />
      </div>

      {/* 2 + 4 — action queue (predict-the-miss, ranked + actionable) */}
      <Panel
        title="Action queue — clear the top first"
        right={
          <span className="flex items-center gap-2 text-[11px]">
            <span className="rounded-full bg-grid px-2 py-0.5 text-ink-2">{openCount} open</span>
            {ackCount > 0 && <span className="text-ink-3">{ackCount} ack’d</span>}
            {breachCount > 0 && (
              <span className="rounded-full px-2 py-0.5 font-medium"
                style={{ background: `color-mix(in srgb, ${SEV_COLOR.critical} 16%, transparent)`, color: "var(--text-primary)" }}>
                {breachCount} SLA breached
              </span>
            )}
          </span>
        }
      >
        <div className="flex flex-col divide-y divide-grid">
          {queue.map((r) => {
            const id = caseId(r);
            const c = cases[id] ?? { status: "new" as const, owner: "", firstSeen: now };
            const remaining = slaMinutes(r) - (now - c.firstSeen) / 60000;
            const resolved = c.status === "resolved";
            const acked = c.status === "ack";
            const breached = c.status === "new" && remaining < 0;
            const dot = resolved ? "var(--status-good)" : acked ? "var(--series-1)" : SEV_COLOR[tone(r.score)];
            const btn = "rounded border border-edge px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink hover:border-baseline";
            return (
              <div key={id} className="py-2.5" style={{ opacity: resolved ? 0.55 : 1 }}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
                  <Link to={shipHref(r)} className="min-w-[104px] text-sm font-medium text-s1 hover:underline">{shipName(r)}</Link>
                  <span className="min-w-[150px] text-xs text-ink-3">
                    {fmt.text(r.product)} · {fmt.text(r.carrier)}{r.region ? ` · ${r.region}` : ""}
                  </span>
                  <span className="flex flex-1 flex-wrap gap-1">
                    {(r.reasons ?? []).map((x: string, j: number) => (
                      <span key={j} className="rounded-full border border-edge px-1.5 py-0.5 text-[11px] text-ink-2">{x}</span>
                    ))}
                  </span>
                  {/* case controls */}
                  <span className="ml-auto flex items-center gap-2">
                    {resolved ? (
                      <span className="text-[11px]" style={{ color: "var(--status-good)" }}>✓ resolved{c.owner ? ` · ${c.owner}` : ""}</span>
                    ) : acked ? (
                      <span className="text-[11px] text-ink-3">ack’d{c.owner ? ` · ${c.owner}` : ""}</span>
                    ) : (
                      <span className="tnum rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{
                          background: breached ? `color-mix(in srgb, ${SEV_COLOR.critical} 16%, transparent)`
                            : remaining < 20 ? `color-mix(in srgb, ${SEV_COLOR.serious} 15%, transparent)` : "var(--grid)",
                          color: breached ? SEV_COLOR.critical : "var(--text-primary)",
                        }}>
                        {breached ? `breached ${fmtMins(remaining)}` : `SLA ${fmtMins(remaining)}`}
                      </span>
                    )}
                    {!resolved && (
                      <select value={c.owner} onChange={(e) => patchCase(id, { owner: e.target.value })}
                        className="rounded border border-edge bg-surface-0 px-1 py-0.5 text-[11px] text-ink-2">
                        <option value="">assign…</option>
                        {OWNERS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                    {resolved ? (
                      <button className={btn} onClick={() => patchCase(id, { status: "new" })}>Reopen</button>
                    ) : (
                      <>
                        {!acked && <button className={btn} onClick={() => patchCase(id, { status: "ack", ackAt: Date.now(), owner: c.owner || "Me" })}>Ack</button>}
                        <button className={btn} onClick={() => patchCase(id, { status: "resolved" })}>Resolve</button>
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-1 pl-4 text-[12px] text-ink-3">{r.play}</div>
              </div>
            );
          })}
          {queue.length === 0 && (
            <div className="py-6 text-center text-sm" style={{ color: "var(--status-good)" }}>✓ Nothing needs intervention right now.</div>
          )}
        </div>
      </Panel>

      {/* 3 — exceptions · 5 — silent feeds */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Exception queue">
          <div className="flex flex-col gap-2">
            {(d.exceptions ?? []).map((e: Dict) => {
              const meta = EXC_META[e.code] ?? { label: e.code, tone: "warning" };
              return (
                <details key={e.code} className="group rounded-md border border-edge">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEV_COLOR[meta.tone] }} />
                    <span className="font-medium">{meta.label}</span>
                    <span className="ml-auto tnum rounded-full bg-grid px-2 py-0.5 text-xs">{e.count}</span>
                  </summary>
                  <div className="border-t border-grid px-3 py-2">
                    {(e.items ?? []).map((it: Dict, j: number) => (
                      <div key={j} className="flex items-center gap-2 py-0.5 text-[13px]">
                        <Link to={shipHref(it)} className="text-s1 hover:underline">{shipName(it)}</Link>
                        <span className="text-ink-3">{fmt.text(it.carrier)} · {fmt.date(it.injectiondate)}</span>
                        <span className="ml-auto text-ink-3">{fmt.text(it.note)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              );
            })}
            {(d.exceptions ?? []).length === 0 && <div className="text-sm text-ink-3">No open exceptions.</div>}
          </div>
        </Panel>

        <Panel title="Silent-feed watchtower">
          <div className="flex flex-col gap-1.5">
            {(d.feeds ?? []).map((ft: Dict) => (
              <div key={ft.feed} className="flex items-center gap-2 rounded-md border border-edge px-3 py-2 text-sm">
                <span className="inline-block h-2 w-2 rounded-full"
                  style={{ background: ft.silent ? SEV_COLOR.critical : "var(--status-good)" }} />
                <span className="font-medium">{ft.feed}</span>
                <span className="ml-auto text-xs" style={{ color: ft.silent ? SEV_COLOR.critical : "var(--text-muted)" }}>
                  {ft.silent ? "SILENT" : "flowing"} · {ft.age_h == null ? "never" : `${ft.age_h}h ago`}
                  <span className="text-ink-3"> (limit {ft.threshold_h}h)</span>
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* 6 — carrier scorecards · 7 — concentration */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Carrier scorecard (active load)">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-baseline text-left text-xs text-ink-3">
                <th className="px-2 py-1">Carrier</th>
                <th className="px-2 py-1 text-right">Active</th>
                <th className="px-2 py-1 text-right">Overdue</th>
                <th className="px-2 py-1 text-right">At risk</th>
                <th className="px-2 py-1 text-right">GPS lost</th>
              </tr>
            </thead>
            <tbody>
              {(d.carriers ?? []).map((c: Dict) => (
                <tr key={c.carrier} className="border-b border-grid">
                  <td className="px-2 py-1.5 font-medium">{c.carrier}</td>
                  <td className="tnum px-2 py-1.5 text-right">{c.active}</td>
                  <td className="tnum px-2 py-1.5 text-right" style={{ color: c.overdue > 0 ? SEV_COLOR.critical : undefined }}>{c.overdue}</td>
                  <td className="tnum px-2 py-1.5 text-right" style={{ color: c.at_risk > 0 ? SEV_COLOR.serious : undefined }}>{c.at_risk}</td>
                  <td className="tnum px-2 py-1.5 text-right" style={{ color: c.gps_lost > 0 ? SEV_COLOR.serious : undefined }}>{c.gps_lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Network concentration — single points of failure">
          <div className="flex flex-col gap-3">
            {(["carrier", "region", "origin"] as const).map((g) => {
              const c = d.concentration?.[g];
              if (!c) return null;
              const label = g[0].toUpperCase() + g.slice(1);
              const conc = c.hhi >= 0.5 ? "Extreme" : c.hhi >= 0.25 ? "High" : c.hhi >= 0.15 ? "Moderate" : "Diversified";
              return (
                <div key={g}>
                  <div className="mb-1 flex items-baseline gap-2 text-xs">
                    <span className="font-medium text-ink-2">{label}s</span>
                    <span className="text-ink-3">top {c.top_pct}% · {conc} (HHI {c.hhi})</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {(c.nodes ?? []).map((n: Dict) => (
                      <div key={n.name} className="grid grid-cols-[110px_1fr_36px] items-center gap-2">
                        <span className="truncate text-xs text-ink-2" title={n.name}>{fmt.text(n.name)}</span>
                        <span className="relative h-2.5 rounded-full bg-grid">
                          <span className="absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${Math.max(3, n.pct)}%`, background: "var(--series-1)" }} />
                        </span>
                        <span className="tnum text-right text-xs text-ink-3">{n.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* 8 — injection calendar */}
      <Panel title="Injection calendar — daily dose load (red = overdue, orange = at-risk)">
        <CalendarHeatmap days={calDays} today={todayIso} />
      </Panel>

      {/* 9a — demand vs capacity outlook */}
      <Panel
        title="Demand vs capacity — upcoming injection load"
        right={
          <span className="text-xs text-ink-3">
            {hasCap
              ? <>capacity ~{fmt.num(dout.capacity_per_day)}/day (proven peak) · {fmt.num(dout.total_upcoming)} upcoming</>
              : <>{fmt.num(dout.total_upcoming)} upcoming · no delivery history to estimate capacity</>}
            {hasCap && dout.crunch_days > 0 && (
              <span className="ml-1 font-medium" style={{ color: SEV_COLOR.critical }}>· {dout.crunch_days} crunch day{dout.crunch_days === 1 ? "" : "s"}</span>
            )}
          </span>
        }
      >
        {(dout.days ?? []).length === 0 ? (
          <div className="py-4 text-sm text-ink-3">No upcoming injections scheduled in the window.</div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {(dout.days ?? []).map((x: Dict) => (
                <div key={x.day} className="grid grid-cols-[96px_1fr_36px] items-center gap-2">
                  <span className="text-xs text-ink-2">{fmt.date(x.day)}</span>
                  <span className="relative h-4 rounded bg-grid">
                    {hasCap && (
                      <span className="absolute inset-y-0 z-10 w-px"
                        style={{ left: `${(Number(dout.capacity_per_day) / dmax) * 100}%`, background: "var(--text-secondary)" }} />
                    )}
                    <span className="absolute inset-y-0 left-0 rounded"
                      style={{ width: `${Math.max(2, (Number(x.demand) / dmax) * 100)}%`, background: x.over_capacity ? SEV_COLOR.critical : "var(--series-1)" }} />
                  </span>
                  <span className="tnum text-right text-xs" style={{ color: x.over_capacity ? SEV_COLOR.critical : "var(--text-secondary)" }}>{x.demand}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-ink-3">
              {hasCap
                ? "Vertical line = proven daily capacity (p90 of historical deliveries); bars past it (red) are crunch days to pre-stage for."
                : "Bars show upcoming injections per day. Capacity can't be estimated until there's delivery history in the window."}
            </div>
          </>
        )}
      </Panel>

      {/* 9 — geographic command map + shift-handover brief */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title={`Command map — ${(d.map_points ?? []).length} at-risk doses plotted`}>
          {(d.map_points ?? []).length === 0 ? (
            <div className="py-6 text-sm text-ink-3">No destination coordinates on the current at-risk doses.</div>
          ) : (
            <MapContainer center={[25, 5]} zoom={2} scrollWheelZoom={false}
              style={{ height: 340, width: "100%", borderRadius: 8, background: "var(--surface-0)" }}>
              <TileLayer url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
                attribution="&copy; CARTO" />
              {(d.map_points ?? []).map((p: Dict, i: number) => (
                <CircleMarker key={i} center={[p.lat, p.lon]} radius={6}
                  pathOptions={{ color: SEV_COLOR[tone(p.score)], fillColor: SEV_COLOR[tone(p.score)], fillOpacity: 0.7, weight: 1 }}>
                  <Tooltip>{p.tn || p.so} · {p.carrier} · score {p.score}</Tooltip>
                </CircleMarker>
              ))}
            </MapContainer>
          )}
        </Panel>

        <Panel
          title="Shift handover brief"
          right={
            <button onClick={copyBrief}
              className="rounded-md border border-edge px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink">
              {copied ? "✓ copied" : "Copy brief"}
            </button>
          }
        >
          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
            <span><b className="text-ink">{openCount}</b> open</span>
            <span><b className="text-ink">{ackCount}</b> in progress</span>
            <span><b className="text-ink">{resolvedCount}</b> resolved</span>
            {breachCount > 0 && <span style={{ color: SEV_COLOR.critical }}><b>{breachCount}</b> SLA breached</span>}
          </div>
          <div className="flex flex-col gap-2.5">
            {HANDOVER_GROUPS.map((g) => {
              const items = briefItems(g.status);
              if (!items.length) return null;
              return (
                <div key={g.status}>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEV_COLOR[g.tone] }} />
                    {g.label} ({items.length})
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {items.slice(0, 6).map((r) => (
                      <div key={r.id} className="flex items-center gap-1.5 text-[12px]">
                        <Link to={r.href} className="text-s1 hover:underline">{r.name}</Link>
                        <span className="truncate text-ink-3">{r.reason}</span>
                        {g.status === "ack" && r.owner && <span className="ml-auto shrink-0 text-ink-3">{r.owner}</span>}
                      </div>
                    ))}
                    {items.length > 6 && <div className="text-[11px] text-ink-3">+{items.length - 6} more</div>}
                  </div>
                </div>
              );
            })}
            {queue.length === 0 && <div className="text-sm text-ink-3">Nothing in the queue.</div>}
          </div>
        </Panel>
      </div>
    </div>
  );
}
