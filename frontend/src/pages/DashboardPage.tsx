import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmt, Dict, ListResponse } from "../api";
import {
  BarList, ErrorBox, KpiTile, Panel, SEV_COLOR, SEV_ICON, SeverityBadge, Spinner, useApi,
} from "../components/ui";

interface Filters {
  search: string;
  carrier: string;
  region: string;
  ordertype: string;
  product: string;
  milestone: string;
  status: string;
  flag: string;
  only_issues: boolean;
  injection_from: string;
  injection_to: string;
  sort: string;
  dir: string;
  page: number;
}

const isoDaysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

// default table window: injections from 15 days back through today
const defaultFilters = (): Filters => ({
  search: "", carrier: "", region: "", ordertype: "", product: "",
  milestone: "", status: "", flag: "", only_issues: false,
  injection_from: isoDaysAgo(15), injection_to: isoDaysAgo(0),
  sort: "lastupdateddt", dir: "desc", page: 1,
});

export default function DashboardPage() {
  const [f, setF] = useState<Filters>(defaultFilters);
  const [searchDraft, setSearchDraft] = useState("");

  const kpis = useApi<Dict>(() => api("/api/kpis"), []);
  const inj = useApi<Dict>(() => api("/api/kpis/injections"), []);
  const feeds = useApi<Dict>(() => api("/api/feeds/health"), []);
  const alerts = useApi<Dict>(() => api("/api/kpis/alerts"), []);
  const meta = useApi<Dict>(() => api("/api/shipments/filters"), []);
  const list = useApi<ListResponse>(
    () => api("/api/shipments", { ...f, only_issues: f.only_issues ? "true" : "", page_size: 50 }),
    [JSON.stringify(f)],
    { keepPrevious: true } // keep the table on screen while a filter refetches
  );

  const set = (patch: Partial<Filters>) => setF((old) => ({ ...old, ...patch, page: patch.page ?? 1 }));

  const flagBars = useMemo(() => {
    const flags: Dict = kpis.data?.flags ?? {};
    return Object.entries(flags)
      .map(([key, v]: [string, any]) => ({
        key, label: v.label, count: v.count ?? 0, severity: v.severity,
      }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [kpis.data]);

  const alertBars = useMemo(
    () =>
      (alerts.data?.alerts ?? []).slice(0, 10).map((a: Dict) => ({
        key: a.title, label: a.title, count: Number(a.n) || 0,
        severity: /alert/i.test(a.title) ? "serious" : "info",
      })),
    [alerts.data]
  );

  const core = kpis.data?.core ?? {};
  const rejects = kpis.data?.rejects ?? {};
  const rejects24 =
    (rejects.rome?.last_24h ?? 0) + (rejects.carrier?.last_24h ?? 0) + (rejects.sensitech?.last_24h ?? 0);

  return (
    <div className="flex flex-col gap-4">
      {/* ---- KPI row ------------------------------------------------------ */}
      {kpis.error ? (
        <ErrorBox error={kpis.error} />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
          <KpiTile label="Active shipments" value={fmt.num(core.active)} sub="not delivered / cancelled"
            onClick={() => set({ status: "active", flag: "", only_issues: false })} active={f.status === "active"} />
          <KpiTile label="In transit" value={fmt.num(core.in_transit)} sub="departed, still moving"
            onClick={() => set({ status: "in_transit", flag: "", only_issues: false })} active={f.status === "in_transit"} />
          <KpiTile label="Delivered today" value={fmt.num(core.delivered_today)} tone="good" />
          <KpiTile label="At risk" value={fmt.num(core.at_risk)} tone={Number(core.at_risk) > 0 ? "serious" : "good"}
            sub="risk bucket high/critical" />
          <KpiTile label="Open alerts" value={fmt.num(core.with_alerts)} tone={Number(core.with_alerts) > 0 ? "warning" : "good"}
            sub="shipments with ≥1 alert" />
          <KpiTile label="Data issues" value={fmt.num(core.with_issues)}
            tone={Number(core.with_issues) > 0 ? "warning" : "good"} sub="active, ≥1 flag raised"
            onClick={() => set({ only_issues: !f.only_issues, flag: "" })} active={f.only_issues} />
          <KpiTile label="Injection overdue" value={fmt.num(kpis.data?.flags?.stale_injection?.count)}
            tone={Number(kpis.data?.flags?.stale_injection?.count) > 0 ? "critical" : "good"}
            sub="past injection date, not closed"
            onClick={() => set({ flag: "stale_injection", only_issues: false })} active={f.flag === "stale_injection"} />
          <KpiTile label="Feed rejects (24h)" value={fmt.num(rejects24)}
            tone={rejects24 > 0 ? "serious" : "good"} sub="rome + carrier + sensitech" />
        </div>
      )}

      {/* ---- injection outlook -------------------------------------------- */}
      <Panel title="Injection outlook — dose status by injection date">
        {inj.loading ? (
          <Spinner label="Loading injection outlook…" />
        ) : inj.error ? (
          <ErrorBox error={inj.error} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-3">
            <InjectionCard label="Today" data={inj.data!.buckets.today} />
            <InjectionCard label="Tomorrow" data={inj.data!.buckets.tomorrow} />
            <InjectionCard label={`Future (next ${inj.data!.future_days} days)`} data={inj.data!.buckets.future} />
          </div>
        )}
      </Panel>

      {/* ---- inbound feed health ------------------------------------------ */}
      <Panel
        title="Inbound feed health — is data flowing?"
        right={
          feeds.data ? (
            feeds.data.problem_feeds > 0 ? (
              <SeverityBadge severity={feeds.data.worst_severity} label={`${feeds.data.problem_feeds} feed(s) need attention`} />
            ) : (
              <SeverityBadge severity="good" label="all feeds flowing" />
            )
          ) : undefined
        }
      >
        {feeds.loading ? (
          <Spinner label="Checking feeds…" />
        ) : feeds.error ? (
          <ErrorBox error={feeds.error} />
        ) : (
          <FeedHealth data={feeds.data!} />
        )}
      </Panel>

      {/* ---- issue breakdowns -------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Data-quality flags (click to filter table)">
          {kpis.loading ? <Spinner /> : <BarList items={flagBars} onClick={(k) => set({ flag: k, only_issues: false })} />}
        </Panel>
        <Panel title="Active alert titles (from shipment alert columns)">
          {alerts.loading ? <Spinner /> : alerts.error ? <ErrorBox error={alerts.error} /> : <BarList items={alertBars} />}
        </Panel>
      </div>

      {/* ---- shipment table ----------------------------------------------- */}
      <Panel
        title={`Shipments ${list.data ? `· ${list.data.total.toLocaleString()} match` : ""}`}
        right={
          f.flag || f.status || f.only_issues || f.search ? (
            <button className="text-xs text-s1 hover:underline" onClick={() => { setSearchDraft(""); setF(defaultFilters()); }}>
              clear filters
            </button>
          ) : undefined
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => { e.preventDefault(); set({ search: searchDraft }); }}
            className="flex items-center gap-1"
          >
            <input
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="SO / tracking / batch / destination…"
              className="w-64 rounded-md border border-edge bg-surface-0 px-2.5 py-1.5 text-sm outline-none focus:border-s1"
            />
            <button className="rounded-md border border-edge px-2.5 py-1.5 text-sm text-ink-2 hover:text-ink">Search</button>
          </form>
          {([
            ["status", ["", "active", "in_transit", "delivered", "cancelled"], "status"],
            ["carrier", ["", ...(meta.data?.carriers ?? [])], "carrier"],
            ["region", ["", ...(meta.data?.regions ?? [])], "region"],
            ["ordertype", ["", ...(meta.data?.ordertypes ?? [])], "order type"],
            ["product", ["", ...(meta.data?.products ?? [])], "product"],
            ["milestone", ["", ...(meta.data?.milestones ?? [])], "milestone"],
          ] as [keyof Filters, string[], string][]).map(([key, opts, label]) => (
            <select
              key={key}
              value={String(f[key] ?? "")}
              onChange={(e) => set({ [key]: e.target.value } as Partial<Filters>)}
              className="rounded-md border border-edge bg-surface-0 px-2 py-1.5 text-sm text-ink-2"
            >
              <option value="">{label}: all</option>
              {opts.filter(Boolean).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ))}
          <select
            value={f.flag}
            onChange={(e) => set({ flag: e.target.value })}
            className="rounded-md border border-edge bg-surface-0 px-2 py-1.5 text-sm text-ink-2"
          >
            <option value="">issue flag: any</option>
            {(meta.data?.flags ?? []).map((fl: Dict) => (
              <option key={fl.code} value={fl.code}>{fl.label}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-ink-2">
            <input type="checkbox" checked={f.only_issues} onChange={(e) => set({ only_issues: e.target.checked })} />
            only flagged
          </label>
          <span className="flex items-center gap-1 text-xs text-ink-3">
            injection
            <input type="date" value={f.injection_from}
              onChange={(e) => set({ injection_from: e.target.value })}
              className="rounded-md border border-edge bg-surface-0 px-1.5 py-1 text-xs text-ink-2" />
            →
            <input type="date" value={f.injection_to}
              onChange={(e) => set({ injection_to: e.target.value })}
              className="rounded-md border border-edge bg-surface-0 px-1.5 py-1 text-xs text-ink-2" />
            {(f.injection_from || f.injection_to) && (
              <button className="text-s1 hover:underline"
                onClick={() => set({ injection_from: "", injection_to: "" })}
                title="Remove the date window (loads across all dates)">
                any date
              </button>
            )}
          </span>
        </div>

        {list.loading ? (
          <Spinner label="Loading shipments…" />
        ) : list.error && !list.data ? (
          <ErrorBox error={list.error} />
        ) : list.data ? (
          // stays mounted while a filter refetches — just dims to signal update
          <div className={list.refreshing ? "pointer-events-none opacity-60 transition-opacity" : "transition-opacity"}>
            <ShipmentTable
              data={list.data}
              sort={f.sort}
              dir={f.dir}
              onSort={(col) =>
                set({ sort: col, dir: f.sort === col && f.dir === "desc" ? "asc" : "desc" })
              }
              onPage={(p) => set({ page: p })}
            />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

/* ---- injection outlook card -------------------------------------------------- */
const STATUS_SEGMENTS: { key: string; label: string; color: string }[] = [
  { key: "delivered", label: "delivered", color: "var(--status-good)" },
  { key: "arrived", label: "arrived", color: "var(--series-2)" },
  { key: "in_transit", label: "in transit", color: "var(--series-1)" },
  { key: "not_started", label: "not started", color: "var(--baseline)" },
  { key: "cancelled", label: "cancelled", color: "var(--status-critical)" },
];

function StackedBar({ data, height = 14 }: { data: Dict; height?: number }) {
  const total = Number(data.total) || 0;
  if (!total) return <div className="h-[14px] rounded bg-grid opacity-40" style={{ height }} />;
  return (
    <div className="flex w-full overflow-hidden rounded-[4px]" style={{ height, gap: 2 }}>
      {STATUS_SEGMENTS.filter((s) => Number(data[s.key]) > 0).map((s) => (
        <div
          key={s.key}
          title={`${s.label}: ${data[s.key]} (${Math.round((data[s.key] / total) * 100)}%)`}
          style={{ width: `${(Number(data[s.key]) / total) * 100}%`, background: s.color, minWidth: 3 }}
        />
      ))}
    </div>
  );
}

function InjectionCard({ label, data }: { label: string; data: Dict }) {
  const total = Number(data.total) || 0;
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "0%");
  return (
    <div className="rounded-lg border border-edge bg-surface-0/50 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        <span className="flex items-center gap-2 text-[11px]">
          {Number(data.critical) > 0 && (
            <span style={{ color: SEV_COLOR.critical }} title="active shipments with high/critical risk">
              ⛔ {data.critical} critical
            </span>
          )}
          {Number(data.with_alerts) > 0 && (
            <span style={{ color: SEV_COLOR.warning }} title="shipments with open alerts">
              ◆ {data.with_alerts} alerts
            </span>
          )}
        </span>
      </div>
      <div className="mt-1 text-2xl font-semibold">{total.toLocaleString()}<span className="ml-1.5 text-xs font-normal text-ink-3">injections</span></div>
      <div className="mt-2"><StackedBar data={data} /></div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-2">
        {STATUS_SEGMENTS.map((s) => (
          <span key={s.key} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label} <span className="tnum text-ink-3">{data[s.key]} ({pct(Number(data[s.key]))})</span>
          </span>
        ))}
      </div>
      {Number(data.delivered) > 0 && (
        <div className="mt-1.5 text-[11px]">
          <span style={{ color: "var(--delta-good)" }}>✓ {data.on_time} on time</span>
          {Number(data.late) > 0 && (
            <span className="ml-2" style={{ color: SEV_COLOR.serious }}>▲ {data.late} late</span>
          )}
          {Number(data.delivered) - Number(data.on_time) - Number(data.late) > 0 && (
            <span className="ml-2 text-ink-3">
              {Number(data.delivered) - Number(data.on_time) - Number(data.late)} no planned date
            </span>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-col gap-1 border-t border-grid pt-2">
        {(["AIR", "ROAD"] as const).map((m) => (
          <div key={m} className="grid grid-cols-[42px_34px_1fr] items-center gap-2">
            <span className="text-[11px] text-ink-3">{m === "AIR" ? "✈ Air" : "▣ Road"}</span>
            <span className="tnum text-right text-[11px] text-ink-2">{data.modes[m].total}</span>
            <StackedBar data={data.modes[m]} height={8} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- inbound feed health table --------------------------------------------- */
function FeedHealth({ data }: { data: Dict }) {
  const feeds: Dict[] = data.feeds ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-baseline text-left text-xs text-ink-3">
            <th className="px-2 py-1">Feed</th>
            <th className="px-2 py-1">Last {data.baseline_days ?? 14} days</th>
            <th className="px-2 py-1 text-right">24 h</th>
            <th className="px-2 py-1 text-right">Typical / day</th>
            <th className="px-2 py-1">Last received</th>
            <th className="px-2 py-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {feeds.map((f) => (
            <tr key={f.key} className="border-b border-grid">
              <td className="whitespace-nowrap px-2 py-1.5">
                <span className="mr-1.5" style={{ color: SEV_COLOR[f.severity] ?? "var(--status-good)" }}>
                  {f.severity === "good" ? SEV_ICON.good : SEV_ICON[f.severity]}
                </span>
                {f.label}
                {f.kind === "rejects" && <span className="ml-1 text-[11px] text-ink-3">(rejects)</span>}
              </td>
              <td className="px-2 py-1.5"><Sparkline daily={f.daily ?? []} /></td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right tnum">{Number(f.last_24h).toLocaleString()}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right tnum text-ink-2">
                {f.median_daily != null ? Number(f.median_daily).toLocaleString() : "—"}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">
                {f.last_received ? (fmt.ago(f.last_received) ?? fmt.dt(f.last_received)) : "never"}
              </td>
              <td className="px-2 py-1.5">
                {f.statuses?.length ? (
                  f.statuses.map((s: Dict) => (
                    <span key={s.code} className="mr-1" title={s.detail}>
                      <SeverityBadge severity={s.severity} label={s.code.replaceAll("_", " ")} />
                    </span>
                  ))
                ) : (
                  <span className="text-xs" style={{ color: "var(--status-good)" }}>✓ flowing</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sparkline({ daily }: { daily: { day: string; n: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.n));
  return (
    <span className="flex h-[22px] items-end gap-px" title={daily.map((d) => `${d.day}: ${d.n}`).join("\n")}>
      {daily.map((d, i) => {
        const last = i === daily.length - 1;
        return (
          <span
            key={d.day}
            className="w-[7px] rounded-t-[2px]"
            style={{
              height: `${d.n === 0 ? 6 : Math.max(12, (d.n / max) * 100)}%`,
              background: d.n === 0 ? "var(--grid)" : "var(--series-1)",
              opacity: d.n === 0 ? 1 : last ? 1 : 0.55,
            }}
          />
        );
      })}
    </span>
  );
}

const COLS: { key: string; label: string; sortable?: boolean }[] = [
  { key: "trackingnumber", label: "Tracking #" },
  { key: "salesordernumber", label: "Sales order", sortable: true },
  { key: "product", label: "Product" },
  { key: "batchnumber", label: "Batch" },
  { key: "carrier", label: "Carrier", sortable: true },
  { key: "modeoftransportation", label: "Mode" },
  { key: "route", label: "Route" },
  { key: "region", label: "Region" },
  { key: "currentmilestone", label: "Milestone" },
  { key: "injectiondate", label: "Injection", sortable: true },
  { key: "planneddeliverydate", label: "Planned", sortable: true },
  { key: "etadeliverytime", label: "ETA" },
  { key: "risk", label: "Risk", sortable: true },
  { key: "issues", label: "Issues" },
  { key: "lastupdateddt", label: "Updated", sortable: true },
];
const TOTAL_COLS = COLS.length + 1; // + expander

function riskSeverity(s: Dict): string {
  return /high|critical/i.test(`${s.risk}${s.riskbucket}`) ? "critical"
    : /med/i.test(`${s.risk}${s.riskbucket}`) ? "warning" : "info";
}

const modeIcon = (m: any) => {
  const v = String(m ?? "").toLowerCase();
  if (/air|flight/.test(v)) return "✈";
  if (/road|ground|truck|drive|courier/.test(v)) return "▣";
  return "";
};

// compact issue cell: one severity-colored count pill (details on hover / expand)
function IssueSummary({ s }: { s: Dict }) {
  const issues = s.issues ?? [];
  if (!issues.length) {
    return <span className="whitespace-nowrap text-xs" style={{ color: "var(--status-good)" }}>✓ clean</span>;
  }
  const sev = s.max_severity ?? "info";
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: SEV_COLOR[sev] }}
      title={issues.map((i: Dict) => `• ${i.label}`).join("\n")}
    >
      <span style={{ color: SEV_COLOR[sev] }}>{SEV_ICON[sev]}</span>
      {s.issue_count} issue{s.issue_count === 1 ? "" : "s"}
    </span>
  );
}

function ShipmentTable({
  data, sort, dir, onSort, onPage,
}: {
  data: ListResponse;
  sort: string;
  dir: string;
  onSort: (c: string) => void;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rowKey = (s: Dict, i: number) => `${s.trackingnumber}-${s.salesordernumber}-${i}`;
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-edge">
        <table className="w-full min-w-[1000px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left">
              <th className="sticky top-0 z-10 w-8 border-b border-baseline bg-surface-1 px-2 py-2.5" />
              {COLS.map((c) => (
                <th
                  key={c.key}
                  onClick={c.sortable ? () => onSort(c.key) : undefined}
                  className={`sticky top-0 z-10 whitespace-nowrap border-b border-baseline bg-surface-1 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3 ${
                    c.sortable ? "cursor-pointer select-none hover:text-ink" : ""
                  }`}
                >
                  {c.label}
                  {sort === c.key && <span className="ml-1 text-s1">{dir === "desc" ? "↓" : "↑"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((s, i) => {
              const k = rowKey(s, i);
              const isOpen = open.has(k);
              return (
                <Fragment key={k}>
                  <tr className={`group border-t border-grid transition-colors first:border-t-0 hover:bg-surface-0 ${isOpen ? "bg-surface-0" : ""}`}>
                    <td className="px-2 py-2.5 align-middle">
                      <button onClick={() => toggle(k)}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-edge hover:text-ink"
                        title={isOpen ? "Collapse" : "Show all fields"}>
                        <span className={`inline-block text-[10px] transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {s.trackingnumber ? (
                        <Link to={`/shipment/${encodeURIComponent(String(s.trackingnumber))}`}
                          className="tnum rounded-md px-1.5 py-0.5 font-medium text-s1 hover:underline"
                          style={{ background: "color-mix(in srgb, var(--series-1) 12%, transparent)" }}>
                          {s.trackingnumber}
                        </Link>
                      ) : s.salesordernumber ? (
                        <Link to={`/shipment/${encodeURIComponent(String(s.salesordernumber))}`} className="text-ink-2 hover:underline" title="No sensitech tracking number — opening by sales order">
                          via SO
                        </Link>
                      ) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tnum text-ink-2">{fmt.text(s.salesordernumber)}</td>
                    <td className="max-w-[140px] truncate px-3 py-2.5 font-medium" title={s.product ?? ""}>{fmt.text(s.product)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 tnum text-ink-2">{fmt.text(s.batchnumber)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {s.carrier ? (
                        <span className="rounded border border-edge px-1.5 py-0.5 text-[11px] font-medium">{s.carrier}</span>
                      ) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-2" title={s.modeoftransportation ?? ""}>
                      <span className="mr-1 text-ink-3">{modeIcon(s.modeoftransportation)}</span>{fmt.text(s.modeoftransportation)}
                    </td>
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-ink-2" title={`${s.origin ?? ""} → ${s.destinationname ?? ""}`}>
                      <span className="text-ink-3">{fmt.text(s.origin)}</span>
                      <span className="mx-1 text-ink-3">→</span>
                      {fmt.text(s.destinationname)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-2">{fmt.text(s.region)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {fmt.text(s.currentmilestone)}
                      {s.currentleg && s.totallegs ? (
                        <span className="ml-1 rounded bg-grid px-1 py-px text-[10px] text-ink-3">leg {s.currentleg}/{s.totallegs}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tnum">{fmt.date(s.injectiondate)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 tnum text-ink-2">{fmt.date(s.planneddeliverydate)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 tnum text-ink-2">{fmt.dt(s.etadeliverytime)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {s.risk || s.riskbucket ? (
                        <SeverityBadge severity={riskSeverity(s)} label={String(s.riskbucket || s.risk)} />
                      ) : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="px-3 py-2.5"><IssueSummary s={s} /></td>
                    <td className="whitespace-nowrap px-3 py-2.5 tnum text-ink-3">{fmt.dt(s.lastupdateddt)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-surface-0">
                      <td />
                      <td colSpan={TOTAL_COLS - 1} className="px-3 pb-3 pt-0.5">
                        <RowDetail s={s} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {data.items.length === 0 && (
              <tr>
                <td colSpan={TOTAL_COLS} className="px-3 py-10 text-center text-sm text-ink-3">
                  No shipments match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-2.5 flex items-center justify-between text-xs text-ink-3">
        <span className="tnum">
          page {data.page} of {pages} · {data.total.toLocaleString()} rows
        </span>
        <span className="flex gap-1">
          <button disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}
            className="rounded border border-edge px-2 py-1 disabled:opacity-40">‹ prev</button>
          <button disabled={data.page >= pages} onClick={() => onPage(data.page + 1)}
            className="rounded border border-edge px-2 py-1 disabled:opacity-40">next ›</button>
        </span>
      </div>
    </div>
  );
}

/* ---- expandable per-row detail: every remaining shipment field, grouped ---- */
function RowDetail({ s }: { s: Dict }) {
  const groups: { title: string; fields: [string, any][] }[] = [
    { title: "Logistics", fields: [
      ["Carrier", s.carrier], ["Mode", s.modeoftransportation], ["Flight #", s.flightnumber],
      ["Carrier tracking #", s.carriertrackingnumber], ["Airway / leg", s.currentleg && s.totallegs ? `${s.currentleg} / ${s.totallegs}` : null],
      ["Shipment type", s.shipmenttype], ["Route", s.route],
    ]},
    { title: "Schedule", fields: [
      ["Injection", `${fmt.date(s.injectiondate)} ${s.injectiontime ?? ""}`.trim()],
      ["Planned delivery", `${fmt.date(s.planneddeliverydate)} ${s.planneddeliverytime ?? ""}`.trim()],
      ["ETA", fmt.dt(s.etadeliverytime)], ["Scheduled departure", fmt.dt(s.scheduledeparted)],
      ["Actual departed", fmt.dt(s.actualdeparted)], ["Actual delivered", fmt.dt(s.actualdeliverytime)],
      ["Vial expiry", fmt.dt(s.vialexpirationtime)], ["Last GPS", fmt.dt(s.lastgps)],
    ]},
    { title: "Location", fields: [
      ["Origin", s.origin], ["Destination", s.destinationname],
      ["Destination address", s.destinationaddress],
      ["City / country", [s.destinationcity, s.destinationcountry].filter(Boolean).join(", ")],
      ["Current location", s.currentlocation], ["Distance", s.distance ? `${s.distance} km` : null],
      ["Geofence", s.geofence_status],
    ]},
    { title: "Dose & product", fields: [
      ["Product", s.product], ["Batch #", s.batchnumber], ["Vial ID", s.vialid],
      ["Dose status", s.dosestatus], ["Order type", s.ordertype],
      ["Account", s.account], ["Production site", s.production_site],
    ]},
    { title: "Status & risk", fields: [
      ["Milestone", `${s.currentmilestone ?? "—"}${s.currentmilestonestep ? ` (step ${s.currentmilestonestep})` : ""}`],
      ["Route status", s.routestatus], ["Risk", s.riskbucket || s.risk], ["Risk reason", s.risk_reason],
      ["Delay reason", s.delayreason], ["Alerts", s.countofalerts && Number(s.countofalerts) > 0 ? `${s.countofalerts} · ${fmt.text(s.alertstitle)}` : null],
      ["POD", s.podname || s.pod_receival_time],
      ["Data issues", (s.issues ?? []).length ? (s.issues as Dict[]).map((i) => i.label).join(", ") : null],
    ]},
  ];
  return (
    <div className="grid gap-3 rounded-md border border-edge bg-surface-1 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {groups.map((g) => (
        <div key={g.title} className="min-w-0">
          <div className="mb-1.5 border-b border-grid pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            {g.title}
          </div>
          <dl className="flex flex-col gap-1">
            {g.fields.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[96px_1fr] items-baseline gap-1.5">
                <dt className="truncate text-[11px] text-ink-3" title={label}>{label}</dt>
                <dd className="min-w-0 break-words text-[12px]" title={value == null ? "" : String(value)}>
                  {fmt.text(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {s.trackingnumber && (
        <div className="sm:col-span-2 lg:col-span-3 xl:col-span-5">
          <Link to={`/shipment/${encodeURIComponent(String(s.trackingnumber))}`}
            className="text-xs text-s1 hover:underline">
            Open full shipment detail (map, ghost pings, milestones) →
          </Link>
        </div>
      )}
    </div>
  );
}
