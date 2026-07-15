import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Dict, fmt } from "../api";
import { ErrorBox, Panel, SEV_COLOR, SeverityBadge, Spinner, useApi } from "../components/ui";

const isoDaysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

interface Template {
  to: string;
  cc: string;
  subject: string;
  intro: string;
  outro: string;
  signature: string;
  sample_limit: number;
}

const TEMPLATE_KEY = "carrier-email-template";

const defaultTemplate = (): Template => ({
  to: "", cc: "", subject: "", intro: "", outro: "",
  signature: "[Your Name]", sample_limit: 5,
});

function loadTemplate(): Template {
  try {
    return { ...defaultTemplate(), ...JSON.parse(localStorage.getItem(TEMPLATE_KEY) ?? "{}") };
  } catch {
    return defaultTemplate();
  }
}

export default function ReportsPage() {
  const meta = useApi<Dict>(() => api("/api/shipments/filters"), []);
  const [start, setStart] = useState(isoDaysAgo(7));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [carrierFilter, setCarrierFilter] = useState<Set<string>>(new Set());

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [report, setReport] = useState<Dict | null>(null);
  const [activeCarrier, setActiveCarrier] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/carrier-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: start, end_date: end,
          carriers: carrierFilter.size ? [...carrierFilter] : null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      const data = await res.json();
      setReport(data);
      setActiveCarrier(data.carriers[0]?.carrier ?? null);
    } catch (e) {
      setError(e);
      setReport(null);
    } finally {
      setRunning(false);
    }
  }

  const carriers: string[] = meta.data?.carriers ?? [];
  const active = report?.carriers?.find((c: Dict) => c.carrier === activeCarrier) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Carrier issue report</h1>
        <p className="text-xs text-ink-3">
          Replays ROME orders in the injection window against carrier events and the expected
          milestone maps — flags missing / unordered / duplicate data per order, then drafts the
          carrier email. Runs <b>only when you hit Run</b>; nothing is fetched automatically.
        </p>
      </div>

      {/* ---- controls --------------------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-edge bg-surface-1 p-3">
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          Injection date from
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
            className="rounded-md border border-edge bg-surface-0 px-2 py-1.5 text-sm text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          to
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
            className="rounded-md border border-edge bg-surface-0 px-2 py-1.5 text-sm text-ink" />
        </label>
        <div className="flex flex-col gap-1 text-xs text-ink-3">
          Carriers (empty = all)
          <div className="flex max-w-[560px] flex-wrap gap-1">
            {carriers.map((c) => {
              const on = carrierFilter.has(c);
              return (
                <button key={c}
                  onClick={() => {
                    const next = new Set(carrierFilter);
                    on ? next.delete(c) : next.add(c);
                    setCarrierFilter(next);
                  }}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    on ? "border-s1 font-medium text-ink" : "border-edge text-ink-2"
                  }`}>
                  {c}
                </button>
              );
            })}
          </div>
        </div>
        <button onClick={run} disabled={running}
          className="ml-auto rounded-md bg-s1 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {running ? "Running…" : "Run report"}
        </button>
      </div>

      {error != null && <ErrorBox error={error} />}
      {running && <Spinner label="Replaying orders against milestone maps…" />}

      {report && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
            <span className="tnum">
              {report.row_count} problematic order-rows · {report.carriers.length} carrier(s) ·{" "}
              {fmt.date(report.start_date)} → {fmt.date(report.end_date)}
            </span>
            {report.truncated && (
              <SeverityBadge severity="warning" label="result truncated — narrow the window" />
            )}
            <button onClick={() => downloadCsv(report)} className="text-xs text-s1 hover:underline">
              ⭳ download CSV (raw flags)
            </button>
          </div>

          {report.carriers.length === 0 ? (
            <div className="py-6 text-sm" style={{ color: "var(--status-good)" }}>
              ✓ No carrier issues found in this window.
            </div>
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[240px_1fr]">
              {/* carrier list */}
              <Panel title="Carriers">
                <div className="flex flex-col gap-1">
                  {report.carriers.map((c: Dict) => (
                    <button key={c.carrier} onClick={() => setActiveCarrier(c.carrier)}
                      className={`flex items-center justify-between rounded-md border px-2.5 py-2 text-left text-sm ${
                        c.carrier === activeCarrier ? "border-s1" : "border-edge text-ink-2"
                      }`}>
                      <span className="font-medium">{c.carrier}</span>
                      <span className="tnum text-xs text-ink-3">
                        {c.issue_count} issues · {c.total_affected_orders} orders
                      </span>
                    </button>
                  ))}
                </div>
              </Panel>
              {active && <CarrierIssues key={active.carrier} carrier={active} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function downloadCsv(report: Dict) {
  const rows: Dict[] = report.rows ?? [];
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, `carrier_issues_${report.start_date}_${report.end_date}.csv`);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---- per-carrier issue tracker + email composer ------------------------------ */
function CarrierIssues({ carrier }: { carrier: Dict }) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(carrier.issues.map((i: Dict) => i.code))
  );
  const [tpl, setTpl] = useState<Template>(loadTemplate);
  const [showTpl, setShowTpl] = useState(false);
  const [draft, setDraft] = useState<Dict | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(tpl));
  }, [tpl]);

  const chosen = useMemo(
    () => carrier.issues.filter((i: Dict) => selected.has(i.code)),
    [carrier, selected]
  );

  async function buildEmail() {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/carrier-issues/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          carrier: carrier.carrier,
          issues: chosen.map((i: Dict) => ({
            name: i.name, description: i.description,
            orders: i.orders, tracking_ids: i.tracking_ids,
          })),
          to: tpl.to, cc: tpl.cc,
          subject: tpl.subject || null,
          intro: tpl.intro || null,
          outro: tpl.outro || null,
          signature: tpl.signature,
          sample_limit: tpl.sample_limit,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      setDraft(await res.json());
    } catch (e) {
      setError(e);
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={`${carrier.carrier} — ${carrier.issue_count} issue type(s), ${carrier.total_affected_orders} affected order(s)`}
        right={
          <span className="text-xs text-ink-3">
            {chosen.length}/{carrier.issues.length} selected for email
          </span>
        }
      >
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-baseline text-left text-xs text-ink-3">
              <th className="px-2 py-1"><input type="checkbox"
                checked={selected.size === carrier.issues.length}
                onChange={(e) => setSelected(e.target.checked
                  ? new Set(carrier.issues.map((i: Dict) => i.code)) : new Set())} /></th>
              <th className="px-2 py-1">Issue</th>
              <th className="px-2 py-1">Observation</th>
              <th className="px-2 py-1 text-right">Orders</th>
              <th className="px-2 py-1">Affected sales orders</th>
            </tr>
          </thead>
          <tbody>
            {carrier.issues.map((i: Dict) => (
              <tr key={i.code} className="border-b border-grid align-top">
                <td className="px-2 py-1.5">
                  <input type="checkbox" checked={selected.has(i.code)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      e.target.checked ? next.add(i.code) : next.delete(i.code);
                      setSelected(next);
                    }} />
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 font-medium">{i.name}</td>
                <td className="px-2 py-1.5 text-ink-2">{i.description}</td>
                <td className="tnum px-2 py-1.5 text-right">{i.order_count}</td>
                <td className="max-w-[300px] px-2 py-1.5 text-xs text-ink-2">
                  {i.orders.slice(0, 6).map((o: string, idx: number) => (
                    <span key={o}>
                      {idx > 0 && ", "}
                      <Link className="text-s1 hover:underline" to={`/shipment/${encodeURIComponent(o)}`}>{o}</Link>
                    </span>
                  ))}
                  {i.orders.length > 6 && <span className="text-ink-3"> +{i.orders.length - 6} more</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* ---- email composer -------------------------------------------------- */}
      <Panel
        title="Carrier email draft"
        right={
          <button onClick={() => setShowTpl(!showTpl)} className="text-xs text-s1 hover:underline">
            {showTpl ? "hide template" : "edit template"}
          </button>
        }
      >
        {showTpl && (
          <div className="mb-3 grid gap-2 rounded-md border border-edge bg-surface-0 p-3 sm:grid-cols-2">
            {([
              ["to", "To", "carrier ops mailbox(es), comma separated"],
              ["cc", "Cc", ""],
              ["subject", "Subject (blank = default)", `NEXUS Prod - ${carrier.carrier} Data Quality Observations`],
              ["signature", "Signature name", ""],
            ] as [keyof Template, string, string][]).map(([k, label, ph]) => (
              <label key={k} className="flex flex-col gap-1 text-xs text-ink-3">
                {label}
                <input value={String(tpl[k])} placeholder={ph}
                  onChange={(e) => setTpl({ ...tpl, [k]: e.target.value })}
                  className="rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-sm text-ink" />
              </label>
            ))}
            <label className="flex flex-col gap-1 text-xs text-ink-3 sm:col-span-2">
              Intro paragraph (blank = default; HTML allowed)
              <textarea value={tpl.intro} rows={2}
                onChange={(e) => setTpl({ ...tpl, intro: e.target.value })}
                className="rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-sm text-ink" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-3 sm:col-span-2">
              Closing line (blank = default)
              <textarea value={tpl.outro} rows={1}
                onChange={(e) => setTpl({ ...tpl, outro: e.target.value })}
                className="rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-sm text-ink" />
            </label>
            <label className="flex w-40 flex-col gap-1 text-xs text-ink-3">
              Sample orders per issue
              <input type="number" min={1} max={25} value={tpl.sample_limit}
                onChange={(e) => setTpl({ ...tpl, sample_limit: Number(e.target.value) || 5 })}
                className="rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-sm text-ink" />
            </label>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={buildEmail} disabled={building || chosen.length === 0}
            className="rounded-md bg-s1 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">
            {building ? "Building…" : `Generate email (${chosen.length} issue${chosen.length === 1 ? "" : "s"})`}
          </button>
          {draft && (
            <>
              <button
                onClick={() => triggerDownload(
                  new Blob([draft.eml], { type: "message/rfc822" }),
                  `${carrier.carrier}_data_quality.eml`)}
                className="rounded-md border border-edge px-3 py-2 text-sm text-ink-2 hover:text-ink"
                title="Opens in Outlook as an editable, unsent draft">
                ⭳ Download .eml draft
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(draft.html)}
                className="rounded-md border border-edge px-3 py-2 text-sm text-ink-2 hover:text-ink">
                ⧉ Copy HTML
              </button>
              <span className="text-xs text-ink-3">subject: {draft.subject}</span>
            </>
          )}
        </div>
        {error != null && <div className="mt-2"><ErrorBox error={error} /></div>}
        {draft && (
          <iframe
            title="email preview"
            srcDoc={draft.html}
            sandbox=""
            className="mt-3 h-[420px] w-full rounded-md border border-edge bg-white"
          />
        )}
      </Panel>
    </div>
  );
}
