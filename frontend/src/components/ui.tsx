import { ReactNode, useEffect, useState } from "react";
import { CsvColumn, Dict, Issue, exportCsv, getCacheVersion, subscribeCacheVersion } from "../api";

/* ---- CSV export ---------------------------------------------------------- */
export function ExportButton({
  filename, rows, columns, label = "Export CSV",
}: {
  filename: string;
  rows: Dict[];
  columns?: CsvColumn[];
  label?: string;
}) {
  const n = rows?.length ?? 0;
  return (
    <button
      onClick={() => exportCsv(filename, rows, columns)}
      disabled={!n}
      title={n ? `Download ${n} rows as CSV` : "Nothing to export"}
      className="rounded-md border border-edge px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink disabled:opacity-40"
    >
      ↓ {label}
    </button>
  );
}

/* ---- severity ----------------------------------------------------------- */
export const SEV_COLOR: Record<string, string> = {
  critical: "var(--status-critical)",
  serious: "var(--status-serious)",
  warning: "var(--status-warning)",
  info: "var(--series-1)",
  good: "var(--status-good)",
};
export const SEV_ICON: Record<string, string> = {
  critical: "⛔", serious: "▲", warning: "◆", info: "ⓘ", good: "✓",
};

export function SeverityBadge({ severity, label }: { severity: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: SEV_COLOR[severity] ?? "var(--border)", color: "var(--text-primary)" }}
    >
      <span style={{ color: SEV_COLOR[severity] }}>{SEV_ICON[severity] ?? "•"}</span>
      {label}
    </span>
  );
}

export function IssueChips({ issues, max = 3 }: { issues: Issue[]; max?: number }) {
  if (!issues?.length) return <span className="text-xs" style={{ color: "var(--status-good)" }}>✓ <span className="text-ink-3">clean</span></span>;
  const shown = issues.slice(0, max);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((i) => (
        <span key={i.code} title={i.hint}>
          <SeverityBadge severity={i.severity} label={i.label} />
        </span>
      ))}
      {issues.length > max && (
        <span className="text-[11px] text-ink-3">+{issues.length - max} more</span>
      )}
    </span>
  );
}

/* ---- stat tile (dataviz contract: label / value / delta / hint) --------- */
export function KpiTile({
  label, value, sub, tone, onClick, active,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "good" | "warning" | "serious" | "critical";
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-lg border bg-surface-1 px-3.5 py-3 text-left transition-shadow ${
        onClick ? "cursor-pointer hover:shadow-md" : "cursor-default"
      }`}
      style={{ borderColor: active ? "var(--series-1)" : "var(--border)" }}
    >
      <div className="text-xs text-ink-2">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{value}</span>
        {tone && (
          <span className="text-sm" style={{ color: SEV_COLOR[tone] }}>
            {SEV_ICON[tone]}
          </span>
        )}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-3">{sub}</div>}
    </button>
  );
}

/* ---- horizontal bar list (issue counts) ---------------------------------- */
export function BarList({
  items, onClick,
}: {
  items: { key: string; label: string; count: number; severity?: string }[];
  onClick?: (key: string) => void;
}) {
  const maxN = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((i) => (
        <button
          key={i.key}
          onClick={() => onClick?.(i.key)}
          disabled={!onClick}
          className={`group grid grid-cols-[190px_1fr_52px] items-center gap-2 text-left ${onClick ? "cursor-pointer" : ""}`}
          title={i.label}
        >
          <span className="truncate text-xs text-ink-2 group-hover:text-ink">{i.label}</span>
          <span className="relative h-[14px] w-full">
            <span className="absolute inset-y-0 left-0 w-full rounded-r-[4px] bg-grid opacity-40" />
            <span
              className="absolute inset-y-0 left-0 rounded-r-[4px]"
              style={{
                width: `${Math.max(1.5, (i.count / maxN) * 100)}%`,
                background: i.severity ? SEV_COLOR[i.severity] : "var(--series-1)",
              }}
            />
          </span>
          <span className="tnum text-right text-xs text-ink-2">{i.count.toLocaleString()}</span>
        </button>
      ))}
      {items.length === 0 && <div className="text-xs text-ink-3">Nothing flagged.</div>}
    </div>
  );
}

/* ---- panels, loading, errors --------------------------------------------- */
export function Panel({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-lg border border-edge bg-surface-1 p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-ink-3">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-baseline border-t-transparent" />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div
      className="rounded-md border px-3 py-2 text-sm"
      style={{ borderColor: "var(--status-critical)", color: "var(--text-primary)" }}
    >
      <span style={{ color: "var(--status-critical)" }}>⛔</span> {msg}
    </div>
  );
}

/* ---- data hook ------------------------------------------------------------
   keepPrevious: stale-while-revalidate — hold the last result on the screen
   while a dep change refetches (no spinner flash / layout jump). `loading` is
   true only until first data arrives; `refreshing` covers subsequent fetches. */
export function useApi<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts?: { keepPrevious?: boolean }
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);
  // re-run when the global Refresh button fires (cache is cleared + version
  // bumped) so a manual refresh re-fetches every mounted view at once.
  const [version, setVersion] = useState(getCacheVersion());
  useEffect(() => subscribeCacheVersion(() => setVersion(getCacheVersion())), []);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError(null);
    if (!opts?.keepPrevious) setData(null);
    fn().then(
      (d) => alive && (setData(d), setBusy(false)),
      (e) => alive && (setError(e), setBusy(false))
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { data, error, loading: busy && data === null, refreshing: busy && data !== null };
}
