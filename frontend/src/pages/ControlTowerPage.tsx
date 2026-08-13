import { useState } from "react";
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

const tone = (score: number) => (score >= 1000 ? "critical" : score >= 400 ? "serious" : "warning");
const shipHref = (r: Dict) => `/shipment/${encodeURIComponent(String(r.trackingnumber || r.salesordernumber))}`;
const shipName = (r: Dict) => r.trackingnumber || `SO ${r.salesordernumber}`;

export default function ControlTowerPage() {
  const data = useApi<Dict>(() => api("/api/control-tower", undefined, { ttl: TTL.DEFAULT }), []);
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

      {/* 2 + 4 — action queue (predict-the-miss, ranked) */}
      <Panel title={`Action queue — clear the top first (${(d.action_queue ?? []).length})`}>
        <div className="flex flex-col divide-y divide-grid">
          {(d.action_queue ?? []).map((r: Dict, i: number) => (
            <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: SEV_COLOR[tone(r.score)] }} />
              <Link to={shipHref(r)} className="min-w-[110px] text-sm font-medium text-s1 hover:underline">{shipName(r)}</Link>
              <span className="min-w-[150px] text-xs text-ink-3">
                {fmt.text(r.product)} · {fmt.text(r.carrier)}{r.region ? ` · ${r.region}` : ""}
              </span>
              <span className="flex flex-1 flex-wrap gap-1">
                {(r.reasons ?? []).map((x: string, j: number) => (
                  <span key={j} className="rounded-full border border-edge px-1.5 py-0.5 text-[11px] text-ink-2">{x}</span>
                ))}
              </span>
              <span className="text-[13px] text-ink-2">{r.play}</span>
            </div>
          ))}
          {(d.action_queue ?? []).length === 0 && (
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

      {/* 9 — geographic command map + shift handover */}
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

        <Panel title={`Shift handover — changed in 12h (${(d.changed_12h ?? []).length})`}>
          <div className="flex flex-col gap-1">
            {(d.changed_12h ?? []).map((it: Dict, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[13px]">
                <Link to={shipHref(it)} className="text-s1 hover:underline">{shipName(it)}</Link>
                <span className="ml-auto truncate text-ink-3" title={String(it.note ?? "")}>{fmt.text(it.note)}</span>
              </div>
            ))}
            {(d.changed_12h ?? []).length === 0 && <div className="text-sm text-ink-3">No changes in the last 12h.</div>}
          </div>
        </Panel>
      </div>
    </div>
  );
}
