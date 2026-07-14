import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmt, Dict, ListResponse } from "../api";
import {
  BarList, ErrorBox, IssueChips, KpiTile, Panel, SEV_COLOR, SEV_ICON, SeverityBadge, Spinner, useApi,
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
  sort: string;
  dir: string;
  page: number;
}

const EMPTY: Filters = {
  search: "", carrier: "", region: "", ordertype: "", product: "",
  milestone: "", status: "", flag: "", only_issues: false,
  sort: "lastupdateddt", dir: "desc", page: 1,
};

export default function DashboardPage() {
  const [f, setF] = useState<Filters>(EMPTY);
  const [searchDraft, setSearchDraft] = useState("");

  const kpis = useApi<Dict>(() => api("/api/kpis"), []);
  const feeds = useApi<Dict>(() => api("/api/feeds/health"), []);
  const alerts = useApi<Dict>(() => api("/api/kpis/alerts"), []);
  const meta = useApi<Dict>(() => api("/api/shipments/filters"), []);
  const list = useApi<ListResponse>(
    () => api("/api/shipments", { ...f, only_issues: f.only_issues ? "true" : "", page_size: 50 }),
    [JSON.stringify(f)]
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
            <button className="text-xs text-s1 hover:underline" onClick={() => { setSearchDraft(""); setF(EMPTY); }}>
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
        </div>

        {list.loading ? (
          <Spinner label="Loading shipments…" />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : (
          <ShipmentTable
            data={list.data!}
            sort={f.sort}
            dir={f.dir}
            onSort={(col) =>
              set({ sort: col, dir: f.sort === col && f.dir === "desc" ? "asc" : "desc" })
            }
            onPage={(p) => set({ page: p })}
          />
        )}
      </Panel>
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
  { key: "route", label: "Route" },
  { key: "currentmilestone", label: "Milestone" },
  { key: "injectiondate", label: "Injection", sortable: true },
  { key: "planneddeliverydate", label: "Planned delivery", sortable: true },
  { key: "risk", label: "Risk", sortable: true },
  { key: "issues", label: "Issues" },
  { key: "lastupdateddt", label: "Updated", sortable: true },
];

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
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-baseline text-left">
              {COLS.map((c) => (
                <th
                  key={c.key}
                  onClick={c.sortable ? () => onSort(c.key) : undefined}
                  className={`whitespace-nowrap px-2 py-1.5 text-xs font-medium text-ink-3 ${
                    c.sortable ? "cursor-pointer select-none hover:text-ink" : ""
                  }`}
                >
                  {c.label}
                  {sort === c.key && <span className="ml-0.5">{dir === "desc" ? "↓" : "↑"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((s, i) => (
              <tr key={`${s.trackingnumber}-${s.salesordernumber}-${i}`} className="border-b border-grid hover:bg-surface-0">
                <td className="whitespace-nowrap px-2 py-1.5">
                  {s.trackingnumber ? (
                    <Link to={`/shipment/${encodeURIComponent(String(s.trackingnumber))}`} className="font-medium text-s1 hover:underline">
                      {s.trackingnumber}
                    </Link>
                  ) : s.salesordernumber ? (
                    <Link to={`/shipment/${encodeURIComponent(String(s.salesordernumber))}`} className="text-ink-2 hover:underline" title="No sensitech tracking number — opening by sales order">
                      (via SO)
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.text(s.salesordernumber)}</td>
                <td className="max-w-[130px] truncate px-2 py-1.5" title={s.product ?? ""}>{fmt.text(s.product)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.text(s.batchnumber)}</td>
                <td className="whitespace-nowrap px-2 py-1.5">{fmt.text(s.carrier)}</td>
                <td className="max-w-[160px] truncate px-2 py-1.5 text-ink-2" title={`${s.origin ?? ""} → ${s.destinationname ?? ""}`}>
                  {fmt.text(s.origin)} → {fmt.text(s.destinationname)}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {fmt.text(s.currentmilestone)}
                  {s.currentleg && s.totallegs ? (
                    <span className="ml-1 text-[11px] text-ink-3">leg {s.currentleg}/{s.totallegs}</span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.date(s.injectiondate)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.date(s.planneddeliverydate)}</td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {s.risk || s.riskbucket ? (
                    <SeverityBadge
                      severity={/high|critical/i.test(`${s.risk}${s.riskbucket}`) ? "critical" : /med/i.test(`${s.risk}${s.riskbucket}`) ? "warning" : "info"}
                      label={String(s.riskbucket || s.risk)}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-2 py-1.5"><IssueChips issues={s.issues} /></td>
                <td className="whitespace-nowrap px-2 py-1.5 tnum text-ink-3">{fmt.dt(s.lastupdateddt)}</td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="px-2 py-8 text-center text-sm text-ink-3">
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
