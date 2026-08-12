import { useState } from "react";
import { Link } from "react-router-dom";
import { api, Dict, fmt } from "../api";
import { ErrorBox, KpiTile, Panel, SEV_COLOR, Spinner, useApi } from "../components/ui";

/* Batch Cohort Blast-Radius — production lots ranked by how many un-injected
   patients one bad lot would strand at once. RLT's true failure unit. */

const LEVELS = [
  { key: "overdue", label: "Overdue", color: "var(--status-critical)" },
  { key: "imminent", label: "Imminent (≤48h)", color: "var(--status-serious)" },
  { key: "upcoming", label: "Upcoming", color: "var(--series-1)" },
  { key: "delivered", label: "Delivered", color: "var(--status-good)" },
  { key: "cancelled", label: "Cancelled", color: "var(--text-muted)" },
] as const;

const LEVEL_COLOR: Record<string, string> = {
  overdue: "var(--status-critical)", imminent: "var(--status-serious)",
  upcoming: "var(--series-1)", done: "var(--status-good)",
};

function riskSev(risk: unknown): string {
  const r = String(risk ?? "").toLowerCase();
  return /high|critical/.test(r) ? "critical" : /med|serious|warn/.test(r) ? "warning" : "info";
}

export default function BatchCohortsPage() {
  const data = useApi<Dict>(() => api("/api/cohorts"), []);
  if (data.loading) return <Spinner label="Grouping doses by production lot…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const cohorts: Dict[] = d.cohorts ?? [];
  const s = d.summary ?? {};
  const patientBasis = cohorts.some((c) => c.patients != null);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Batch Cohort Blast-Radius</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-ink-3">
          One Lu-177 lot is split into per-patient vials from a single decay-synchronised run — so a
          batch hold or shared-carrier delay strands <em>every</em> un-injected patient in that lot at
          once. Lots are ranked by that blast-radius: the undelivered {patientBasis ? "patients" : "doses"} depending on them.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="Lots at risk" value={fmt.num(s.cohorts_at_risk)}
          tone={s.cohorts_at_risk > 0 ? "serious" : "good"} sub={`of ${fmt.num(s.cohorts)} in window`} />
        <KpiTile label={patientBasis ? "Patients at risk" : "Doses at risk"} value={fmt.num(s.doses_at_risk)}
          tone={s.doses_at_risk > 0 ? "serious" : "good"} sub="undelivered, injection due" />
        <KpiTile label="Overdue" value={fmt.num(s.overdue)}
          tone={s.overdue > 0 ? "critical" : "good"} sub="injection date passed" />
        <KpiTile label="Imminent (≤48h)" value={fmt.num(s.imminent)}
          tone={s.imminent > 0 ? "serious" : "good"} />
        <KpiTile label="Largest blast-radius" value={fmt.num(s.largest_blast_radius)}
          tone={s.largest_blast_radius > 1 ? "serious" : undefined} sub="worst single lot" />
        <KpiTile label="Multi-dose lots" value={fmt.num(s.multi_dose_cohorts)}
          sub="shared production runs" />
      </div>

      <Panel title={`Production lots · ${cohorts.length} in the injection window (worst first)`}>
        <div className="flex flex-col gap-2.5">
          {cohorts.map((c) => <CohortCard key={c.batch_no} c={c} patientBasis={patientBasis} />)}
          {cohorts.length === 0 && (
            <div className="py-6 text-center text-sm" style={{ color: "var(--status-good)" }}>
              ✓ No batches with injection-dated shipments in the window.
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function CohortCard({ c, patientBasis }: { c: Dict; patientBasis: boolean }) {
  const [open, setOpen] = useState(false);
  const blast = Number(c.blast_radius) || 0;
  const tone = c.overdue > 0 ? "critical" : c.imminent > 0 ? "serious" : c.active > 0 ? "info" : "good";
  const counts: Record<string, number> = {
    overdue: c.overdue, imminent: c.imminent, upcoming: c.upcoming,
    delivered: c.delivered, cancelled: c.cancelled,
  };
  const total = Number(c.doses) || 1;
  const impacted = /hold|impact|recall|quarantin|reject|block/i.test(String(c.batch_status ?? ""));

  return (
    <div className="rounded-lg border bg-surface-1" style={{ borderColor: SEV_COLOR[tone] }}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left">
        {/* identity */}
        <div className="min-w-[180px]">
          <div className="flex items-center gap-2">
            <span className="tnum text-base font-semibold">{fmt.text(c.batch_no)}</span>
            {c.product && (
              <span className="rounded border border-edge px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                {fmt.text(c.product)}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-3">
            {[c.sites?.join(", "), c.carriers?.join(", ")].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>

        {/* blast-radius hero */}
        <div className="flex items-baseline gap-1.5">
          <span className="tnum text-2xl font-semibold" style={{ color: SEV_COLOR[tone] }}>{blast}</span>
          <span className="text-xs text-ink-3">{patientBasis ? "patients" : "doses"} at risk</span>
        </div>

        {/* stacked bar */}
        <div className="flex min-w-[180px] flex-1 items-center gap-3">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-grid">
            {LEVELS.map((l) => {
              const n = counts[l.key] || 0;
              if (!n) return null;
              return <div key={l.key} title={`${l.label}: ${n}`}
                style={{ width: `${(n / total) * 100}%`, background: l.color }} />;
            })}
          </div>
          <span className="tnum whitespace-nowrap text-[11px] text-ink-3">{c.doses} doses</span>
        </div>

        {/* badges */}
        <div className="flex items-center gap-1.5">
          {c.batch_status && (
            <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium"
              style={{ borderColor: impacted ? SEV_COLOR.critical : "var(--border)", color: "var(--text-primary)" }}>
              {impacted ? "⚠ " : ""}{fmt.text(c.batch_status)}
            </span>
          )}
          {c.risk_max && (
            <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ background: `color-mix(in srgb, ${SEV_COLOR[riskSev(c.risk_max)]} 16%, transparent)` }}>
              risk {fmt.text(c.risk_max)}
            </span>
          )}
          <span className="ml-1 text-ink-3">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-grid px-4 py-3">
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
            {LEVELS.filter((l) => counts[l.key] > 0).map((l) => (
              <span key={l.key} className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
                {l.label}: {counts[l.key]}
              </span>
            ))}
            <span className="ml-auto">
              injection {fmt.date(c.earliest_injection)} → {fmt.date(c.latest_injection)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-baseline text-left text-xs text-ink-3">
                  <th className="px-2 py-1">Tracking / SO</th>
                  <th className="px-2 py-1">Injection</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Milestone</th>
                  <th className="px-2 py-1">Carrier</th>
                  <th className="px-2 py-1">Destination</th>
                </tr>
              </thead>
              <tbody>
                {(c.members ?? []).map((m: Dict, i: number) => (
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
                          style={{ background: LEVEL_COLOR[m.level] ?? "var(--text-muted)" }} />
                        {m.status === "active" ? m.level : m.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{fmt.text(m.currentmilestone)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">{fmt.text(m.carrier)}</td>
                    <td className="max-w-[160px] truncate px-2 py-1.5 text-ink-2">{fmt.text(m.destinationname)}</td>
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
