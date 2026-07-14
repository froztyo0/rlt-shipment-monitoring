import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Dict, fmt } from "../api";
import {
  BarList, ErrorBox, Panel, SEV_COLOR, SeverityBadge, Spinner, useApi,
} from "../components/ui";

type Tab = "quality" | "sequence" | "stale" | "rejects";

const TABS: { id: Tab; label: string }[] = [
  { id: "quality", label: "Data quality" },
  { id: "sequence", label: "Milestone sequence" },
  { id: "stale", label: "Overdue injections (RCA)" },
  { id: "rejects", label: "Feed rejects" },
];

export default function OpsPage() {
  const [tab, setTab] = useState<Tab>("quality");
  const kpis = useApi<Dict>(() => api("/api/kpis"), []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 border-b border-edge">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id ? "border-s1 text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "quality" && <QualityTab kpis={kpis.data} />}
      {tab === "sequence" && <SequenceTab />}
      {tab === "stale" && <StaleTab />}
      {tab === "rejects" && <RejectsTab kpis={kpis.data} />}
    </div>
  );
}

/* ---- data quality ---------------------------------------------------------- */
function QualityTab({ kpis }: { kpis: Dict | null }) {
  const [flag, setFlag] = useState<string>("missing_batch");
  const list = useApi<Dict>(() => api("/api/ops/data-quality", { flag }), [flag]);

  const bars = useMemo(() => {
    const flags: Dict = kpis?.flags ?? {};
    return Object.entries(flags)
      .map(([key, v]: [string, any]) => ({ key, label: v.label, count: v.count ?? 0, severity: v.severity }))
      .filter((b) => b.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [kpis]);

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Panel title="Flag volumes (active window)">
        {!kpis ? <Spinner /> : <BarList items={bars} onClick={setFlag} />}
      </Panel>
      <Panel title={`Shipments: ${list.data?.meta?.label ?? flag}`}>
        {list.loading ? (
          <Spinner />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-3">{list.data!.meta.hint}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-baseline text-left text-xs text-ink-3">
                    <th className="px-2 py-1">Tracking / SO</th>
                    <th className="px-2 py-1">Product</th>
                    <th className="px-2 py-1">Carrier</th>
                    <th className="px-2 py-1">Milestone</th>
                    <th className="px-2 py-1">Injection</th>
                    <th className="px-2 py-1">Diagnosis (where is the data?)</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data!.items.map((r: Dict, i: number) => (
                    <tr key={i} className="border-b border-grid">
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <ShipLink r={r} />
                      </td>
                      <td className="max-w-[120px] truncate px-2 py-1.5">{fmt.text(r.product)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{fmt.text(r.carrier)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{fmt.text(r.currentmilestone)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.date(r.injectiondate)}</td>
                      <td className="px-2 py-1.5 text-ink-2">
                        <Diagnosis text={r.diagnosis} upstream={r.upstream} />
                      </td>
                    </tr>
                  ))}
                  {list.data!.items.length === 0 && (
                    <tr><td colSpan={6} className="px-2 py-6 text-center text-ink-3">Nothing flagged 🎉</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function Diagnosis({ text, upstream }: { text: string; upstream: Dict }) {
  const sev = /REJECTED/i.test(text) ? "serious" : /Never received/i.test(text) ? "critical" : "warning";
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <SeverityBadge severity={sev} label={text} />
      {upstream && Object.entries(upstream).map(([k, v]) => (
        <span key={k} className="text-[11px] text-ink-3">
          {k.replace("in_", "")}: {v ? "✓" : "✗"}
        </span>
      ))}
    </span>
  );
}

/* ---- sequence violations ------------------------------------------------ */
function SequenceTab() {
  const data = useApi<Dict>(() => api("/api/ops/sequence-violations"), []);
  if (data.loading) return <Spinner label="Replaying carrier events against milestone maps…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  return (
    <Panel
      title={`Sequence violations · checked ${d.checked_orders} recent orders (${d.orders_with_events} with events) → ${d.orders_with_issues} flagged`}
    >
      <div className="flex flex-col gap-3">
        {d.violations.map((v: Dict) => (
          <div key={v.salesordernumber} className="rounded-md border border-edge p-2.5">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm">
              <ShipLink r={v} />
              <span className="text-ink-3">·</span>
              <span>{fmt.text(v.carrier)}</span>
              <span className="rounded bg-grid px-1.5 py-0.5 text-[11px] text-ink-2">{v.mode}</span>
              <span className="text-xs text-ink-3">{v.event_count} events</span>
              <span className="ml-auto text-xs text-ink-3">{fmt.text(v.product)} · {fmt.text(v.region)}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {v.issues.map((it: Dict, i: number) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <SeverityBadge severity={it.severity} label={it.type.replaceAll("_", " ")} />
                  <span className="text-ink-2">{it.detail}</span>
                  {it.at && <span className="ml-auto whitespace-nowrap text-xs text-ink-3 tnum">{fmt.dt(it.at)}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {d.violations.length === 0 && (
          <div className="py-4 text-sm" style={{ color: "var(--status-good)" }}>
            ✓ No milestone sequence violations in the checked window.
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ---- stale injections ------------------------------------------------------ */
function StaleTab() {
  const data = useApi<Dict>(() => api("/api/ops/stale-injections"), []);
  if (data.loading) return <Spinner label="Classifying overdue shipments…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const labels: Dict = d.verdict_labels ?? {};
  const verdictSev: Dict = {
    cancelled_upstream: "warning", delivered_not_closed: "warning", arrived_no_pod: "warning",
    gps_lost_in_transit: "serious", no_sensitech_data: "serious", carrier_silent: "critical",
    never_departed: "critical", unexplained: "critical",
  };
  const bars = Object.entries(d.by_verdict ?? {}).map(([k, n]) => ({
    key: k, label: labels[k] ?? k, count: Number(n), severity: verdictSev[k] ?? "warning",
  })).sort((a, b) => b.count - a.count);

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
      <Panel title={`Root causes · ${d.total} overdue shipments`}>
        <BarList items={bars} />
      </Panel>
      <Panel title="Overdue shipments (injection date passed, not delivered / cancelled)">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-baseline text-left text-xs text-ink-3">
                <th className="px-2 py-1">Tracking / SO</th>
                <th className="px-2 py-1">Injection</th>
                <th className="px-2 py-1">Milestone</th>
                <th className="px-2 py-1">Carrier</th>
                <th className="px-2 py-1">Verdict</th>
                <th className="px-2 py-1">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((r: Dict, i: number) => (
                <tr key={i} className="border-b border-grid align-top">
                  <td className="whitespace-nowrap px-2 py-1.5"><ShipLink r={r} /></td>
                  <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.date(r.injectiondate)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{fmt.text(r.currentmilestone)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{fmt.text(r.carrier)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <SeverityBadge severity={verdictSev[r.verdict] ?? "warning"} label={labels[r.verdict] ?? r.verdict} />
                  </td>
                  <td className="px-2 py-1.5 text-ink-2">{r.detail}</td>
                </tr>
              ))}
              {d.items.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-ink-3">No overdue injections 🎉</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/* ---- rejects ----------------------------------------------------------------- */
function RejectsTab({ kpis }: { kpis: Dict | null }) {
  const [source, setSource] = useState<"rome" | "carrier" | "sensitech">("carrier");
  const [hours, setHours] = useState(168);
  const data = useApi<Dict>(() => api("/api/ops/rejects", { source, hours }), [source, hours]);
  const counts = kpis?.rejects ?? {};

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["rome", "carrier", "sensitech"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSource(s)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              source === s ? "border-s1 font-medium text-ink" : "border-edge text-ink-2"
            }`}
          >
            {s} rejects
            {counts[s] && (
              <span className="ml-1.5 rounded-full px-1.5 text-[11px]"
                style={{ background: "color-mix(in srgb, var(--status-serious) 15%, transparent)", color: "var(--text-primary)" }}>
                {counts[s].last_24h} /24h
              </span>
            )}
          </button>
        ))}
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))}
          className="ml-auto rounded-md border border-edge bg-surface-0 px-2 py-1.5 text-sm text-ink-2">
          <option value={24}>last 24 h</option>
          <option value={72}>last 3 days</option>
          <option value={168}>last 7 days</option>
          <option value={720}>last 30 days</option>
        </select>
      </div>

      {data.loading ? (
        <Spinner />
      ) : data.error ? (
        <ErrorBox error={data.error} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
          <Panel title="Grouped by error message">
            <BarList
              items={(data.data!.by_error ?? []).map((g: Dict) => ({
                key: g.error_message, label: g.error_message, count: Number(g.n), severity: "serious",
              }))}
            />
          </Panel>
          <Panel title={`Raw ${source} rejects (${data.data!.items.length})`}>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-1">
                  <tr className="border-b border-baseline text-left text-ink-3">
                    <th className="px-2 py-1">When</th>
                    <th className="px-2 py-1">Sales order</th>
                    {source === "carrier" && <th className="px-2 py-1">Carrier / event</th>}
                    {source === "rome" && <th className="px-2 py-1">Status / type</th>}
                    {source === "sensitech" && <th className="px-2 py-1">Trip / device</th>}
                    <th className="px-2 py-1">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data!.items.map((r: Dict, i: number) => (
                    <tr key={i} className="border-b border-grid align-top">
                      <td className="whitespace-nowrap px-2 py-1 tnum">{fmt.dt(r.audit_timestamp)}</td>
                      <td className="whitespace-nowrap px-2 py-1">
                        {r.salesordernumber ? (
                          <Link className="text-s1 hover:underline" to={`/shipment/${encodeURIComponent(r.salesordernumber)}`}>
                            {r.salesordernumber}
                          </Link>
                        ) : "—"}
                      </td>
                      {source === "carrier" && (
                        <td className="whitespace-nowrap px-2 py-1">{fmt.text(r.carriername)} · {fmt.text(r.event)}</td>
                      )}
                      {source === "rome" && (
                        <td className="whitespace-nowrap px-2 py-1">{fmt.text(r.orderstatus)} · {fmt.text(r.ordertype)}</td>
                      )}
                      {source === "sensitech" && (
                        <td className="whitespace-nowrap px-2 py-1">{fmt.text(r.tripid)} · {fmt.text(r.deviceserialnumber)}</td>
                      )}
                      <td className="px-2 py-1" style={{ color: SEV_COLOR.serious }}>
                        {fmt.text(r.error_message)}
                      </td>
                    </tr>
                  ))}
                  {data.data!.items.length === 0 && (
                    <tr><td colSpan={4} className="px-2 py-6 text-center text-ink-3">No rejects in this window 🎉</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

/* ---- shared ------------------------------------------------------------------- */
function ShipLink({ r }: { r: Dict }) {
  const target = r.trackingnumber || r.salesordernumber;
  if (!target) return <span>—</span>;
  return (
    <Link to={`/shipment/${encodeURIComponent(String(target))}`} className="font-medium text-s1 hover:underline">
      {r.trackingnumber || `SO ${r.salesordernumber}`}
    </Link>
  );
}
