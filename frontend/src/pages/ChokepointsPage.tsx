import { useState } from "react";
import { Link } from "react-router-dom";
import { api, Dict, fmt, TTL } from "../api";
import { ErrorBox, ExportButton, KpiTile, Panel, SEV_COLOR, Spinner, useApi } from "../components/ui";
import { Sankey } from "../components/charts";

/* Chokepoint / SPOF board — the dose flow as a origin→carrier→hub→region graph,
   with every node ranked by how many un-injected doses it would strand if it
   failed, plus a concentration index per layer. */

const LEVELS = [
  { key: "overdue", label: "Overdue", color: "var(--status-critical)" },
  { key: "imminent", label: "Imminent (≤48h)", color: "var(--status-serious)" },
  { key: "upcoming", label: "Upcoming", color: "var(--series-1)" },
] as const;

const LAYER_BADGE: Record<string, { label: string; color: string }> = {
  carrier: { label: "carrier", color: "var(--series-1)" },
  hub: { label: "hub", color: "var(--series-5)" },
  origin: { label: "origin", color: "var(--series-4)" },
  region: { label: "region", color: "var(--series-8)" },
};

function concLabel(hhi: number): { text: string; tone: string } {
  if (hhi >= 0.5) return { text: "Extreme", tone: "critical" };
  if (hhi >= 0.25) return { text: "High", tone: "serious" };
  if (hhi >= 0.15) return { text: "Moderate", tone: "warning" };
  return { text: "Diversified", tone: "good" };
}

export default function ChokepointsPage() {
  const data = useApi<Dict>(() => api("/api/chokepoints", undefined, { ttl: TTL.STABLE }), []);
  if (data.loading) return <Spinner label="Mapping the dose-flow network…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const s = d.summary ?? {};
  const layers: Dict[] = d.layers ?? [];
  const top: Dict[] = d.top_chokepoints ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight">Chokepoints &amp; single points of failure</h1>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <KpiTile label="Active doses in window" value={fmt.num(s.active_doses)} sub="un-injected, scheduled" />
        <KpiTile label="Chokepoints" value={fmt.num(s.chokepoints)}
          tone={s.chokepoints > 0 ? "serious" : "good"} sub="nodes ≥3 doses depend on" />
        <KpiTile label="Worst blast-radius" value={fmt.num(s.worst_blast_radius)}
          tone={s.worst_blast_radius >= 3 ? "critical" : undefined} sub="single riskiest node" />
        <KpiTile label="Most concentrated" value={fmt.text(s.most_concentrated_layer)}
          sub="least fallback" />
      </div>

      {d.flow?.columns?.length > 0 && (
        <Panel title="Dose flow — origin → carrier → hub → region (band width = active doses)">
          <Sankey columns={d.flow.columns} links={d.flow.links}
            colColors={[LAYER_BADGE.origin.color, LAYER_BADGE.carrier.color, LAYER_BADGE.hub.color, LAYER_BADGE.region.color]} />
        </Panel>
      )}

      <Panel
        title="Top chokepoints — nodes that strand the most doses"
        right={<ExportButton filename="chokepoints" rows={top} columns={[
          "layer", "name", "doses", "active", "blast_radius", "overdue", "imminent", "upcoming",
        ]} />}
      >
        <div className="flex flex-col gap-2">
          {top.map((n) => <NodeRow key={`${n.layer}-${n.name}`} n={n} expandable />)}
          {top.length === 0 && (
            <div className="py-6 text-center text-sm" style={{ color: "var(--status-good)" }}>
              ✓ No active doses in the window.
            </div>
          )}
        </div>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        {layers.map((l) => <LayerCard key={l.key} l={l} />)}
      </div>
    </div>
  );
}

function LayerCard({ l }: { l: Dict }) {
  const conc = concLabel(Number(l.hhi) || 0);
  const nodes: Dict[] = l.nodes ?? [];
  const maxActive = Math.max(1, ...nodes.map((n) => Number(n.active) || 0));
  return (
    <Panel
      title={l.label}
      right={
        <span className="flex items-center gap-1.5 text-xs">
          <span className="rounded-full px-2 py-0.5 font-medium"
            style={{ background: `color-mix(in srgb, ${SEV_COLOR[conc.tone]} 16%, transparent)`, color: "var(--text-primary)" }}>
            {conc.text}
          </span>
          <span className="text-ink-3">HHI {Number(l.hhi).toFixed(2)}</span>
        </span>
      }
    >
      <div className="mb-2 text-[11px] text-ink-3">
        {l.node_count} {l.node_label}{l.node_count === 1 ? "" : "s"} · {l.total_active} active doses ·
        top {fmt.text(l.top_node)} carries {fmt.num(l.top_share_pct)}%
        {l.sole_path && <span className="ml-1 font-medium" style={{ color: SEV_COLOR.critical }}>· sole path</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        {nodes.slice(0, 6).map((n) => (
          <div key={n.name} className="grid items-center gap-2" style={{ gridTemplateColumns: "130px 1fr 34px" }}>
            <span className="truncate text-xs text-ink-2" title={n.name}>{fmt.text(n.name)}</span>
            <span className="relative h-[14px]">
              <span className="absolute inset-y-0 left-0 w-full rounded-[3px] bg-grid opacity-40" />
              <span className="absolute inset-y-0 left-0 flex overflow-hidden rounded-[3px]"
                style={{ width: `${Math.max(2, (Number(n.active) / maxActive) * 100)}%` }}>
                {LEVELS.map((lv) => {
                  const v = Number(n[lv.key]) || 0;
                  if (!v || !n.active) return null;
                  return <span key={lv.key} style={{ width: `${(v / n.active) * 100}%`, background: lv.color }} />;
                })}
              </span>
            </span>
            <span className="tnum text-right text-xs text-ink-2">{n.active}</span>
          </div>
        ))}
        {nodes.length === 0 && <div className="text-xs text-ink-3">No active flow in this layer.</div>}
      </div>
    </Panel>
  );
}

function NodeRow({ n, expandable }: { n: Dict; expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  const badge = LAYER_BADGE[n.layer] ?? { label: n.layer, color: "var(--text-muted)" };
  const tone = n.overdue > 0 ? "critical" : n.imminent > 0 ? "serious" : "info";
  const total = Number(n.active) || 1;
  return (
    <div className="rounded-lg border bg-surface-1" style={{ borderColor: SEV_COLOR[tone] }}>
      <button onClick={() => expandable && setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-left">
        <div className="flex min-w-[190px] items-center gap-2">
          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ background: `color-mix(in srgb, ${badge.color} 18%, transparent)`, color: "var(--text-primary)" }}>
            {badge.label}
          </span>
          <span className="truncate text-sm font-semibold" title={n.name}>{fmt.text(n.name)}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="tnum text-xl font-semibold" style={{ color: SEV_COLOR[tone] }}>{n.blast_radius}</span>
          <span className="text-xs text-ink-3">doses stranded if it fails</span>
        </div>
        <div className="flex min-w-[160px] flex-1 items-center gap-3">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-grid">
            {LEVELS.map((lv) => {
              const v = Number(n[lv.key]) || 0;
              if (!v) return null;
              return <div key={lv.key} title={`${lv.label}: ${v}`}
                style={{ width: `${(v / total) * 100}%`, background: lv.color }} />;
            })}
          </div>
          <span className="tnum whitespace-nowrap text-[11px] text-ink-3">
            {n.overdue > 0 && <span style={{ color: SEV_COLOR.critical }}>{n.overdue} overdue</span>}
            {n.overdue > 0 && n.imminent > 0 && " · "}
            {n.imminent > 0 && <span style={{ color: SEV_COLOR.serious }}>{n.imminent} imminent</span>}
          </span>
        </div>
        {expandable && <span className="text-ink-3">{open ? "▲" : "▼"}</span>}
      </button>
      {open && (
        <div className="border-t border-grid px-4 py-2.5">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-baseline text-left text-xs text-ink-3">
                  <th className="px-2 py-1">Tracking / SO</th>
                  <th className="px-2 py-1">Injection</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Carrier</th>
                  <th className="px-2 py-1">Milestone</th>
                </tr>
              </thead>
              <tbody>
                {(n.members ?? []).filter((m: Dict) => m.active).map((m: Dict, i: number) => (
                  <tr key={i} className="border-b border-grid">
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Link className="font-medium text-s1 hover:underline"
                        to={`/shipment/${encodeURIComponent(String(m.trackingnumber || m.salesordernumber))}`}>
                        {m.trackingnumber || `SO ${m.salesordernumber}`}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.date(m.injectiondate)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span className="inline-flex items-center gap-1 text-xs">
                        <span className="inline-block h-2 w-2 rounded-full"
                          style={{ background: (LEVELS.find((l) => l.key === m.level)?.color) ?? "var(--text-muted)" }} />
                        {m.level}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{fmt.text(m.carrier)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{fmt.text(m.currentmilestone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
