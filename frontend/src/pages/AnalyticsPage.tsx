import { useState } from "react";
import { api, Dict, fmt } from "../api";
import { ErrorBox, KpiTile, Panel, Spinner, useApi } from "../components/ui";
import { Datum, Donut, HBarChart, StackedColumns } from "../components/charts";

const WINDOWS = [30, 60, 90, 180];

const STATUS_COLORS: Record<string, string> = {
  delivered: "var(--status-good)",
  arrived: "var(--series-2)",
  in_transit: "var(--series-1)",
  not_started: "var(--baseline)",
  cancelled: "var(--status-critical)",
};

export default function AnalyticsPage() {
  const [win, setWin] = useState(30);
  const carriers = useApi<Dict>(() => api("/api/analytics/carriers", { window_days: win }), [win]);
  const overview = useApi<Dict>(() => api("/api/analytics/overview", { window_days: win }), [win]);

  const t: Dict = overview.data?.totals ?? {};
  const carrierRows: Dict[] = carriers.data?.carriers ?? [];

  const onTimeBars: Datum[] = carrierRows
    .filter((c) => c.on_time_pct != null)
    .map((c) => ({ label: c.carrier, value: c.on_time_pct }))
    .sort((a, b) => b.value - a.value);

  const volumeBars: Datum[] = carrierRows
    .map((c) => ({ label: c.carrier, value: c.total }))
    .sort((a, b) => b.value - a.value);

  const statusData: Datum[] = [
    { label: "Delivered", value: t.delivered ?? 0, color: STATUS_COLORS.delivered },
    { label: "Arrived", value: t.arrived ?? 0, color: STATUS_COLORS.arrived },
    { label: "In transit", value: t.in_transit ?? 0, color: STATUS_COLORS.in_transit },
    { label: "Not started", value: t.not_started ?? 0, color: STATUS_COLORS.not_started },
    { label: "Cancelled", value: t.cancelled ?? 0, color: STATUS_COLORS.cancelled },
  ];

  const modeData: Datum[] = [
    { label: "Air", value: t.air ?? 0, color: "var(--series-1)" },
    { label: "Road", value: t.road ?? 0, color: "var(--series-3)" },
  ];

  const weekly = (overview.data?.weekly ?? []).map((w: Dict) => ({
    label: w.week,
    values: {
      on_time: w.on_time,
      late: w.late,
      other: Math.max(0, w.delivered - w.on_time - w.late),
    },
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Analytics</h1>
        <span className="text-xs text-ink-3">shipments by injection date, last {win} days</span>
        <div className="ml-auto flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setWin(w)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                win === w ? "border-s1 font-medium text-ink" : "border-edge text-ink-2 hover:text-ink"
              }`}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      {/* ---- KPI row ------------------------------------------------------- */}
      {overview.error ? (
        <ErrorBox error={overview.error} />
      ) : overview.loading ? (
        <Spinner label="Loading analytics…" />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile label="Shipments" value={fmt.num(t.total)} sub={`last ${win} days`} />
          <KpiTile label="On-time delivery" value={t.on_time_pct != null ? `${t.on_time_pct}%` : "—"}
            tone={t.on_time_pct == null ? undefined : t.on_time_pct >= 90 ? "good" : t.on_time_pct >= 75 ? "warning" : "serious"}
            sub={`${t.on_time ?? 0} on time · ${t.late ?? 0} late`} />
          <KpiTile label="Avg transit time" value={t.avg_transit_hours != null ? `${t.avg_transit_hours}h` : "—"}
            sub="departed → delivered" />
          <KpiTile label="Delivered" value={fmt.num(t.delivered)} tone="good" sub={`of ${fmt.num(t.total)}`} />
          <KpiTile label="Cancelled" value={fmt.num(t.cancelled)}
            tone={Number(t.cancelled) > 0 ? "serious" : "good"} />
          <KpiTile label="At risk (active)" value={fmt.num(t.at_risk)}
            tone={Number(t.at_risk) > 0 ? "serious" : "good"} sub="high/critical risk" />
        </div>
      )}

      {/* ---- carrier performance ------------------------------------------- */}
      <Panel title="Carrier performance">
        {carriers.loading ? (
          <Spinner />
        ) : carriers.error ? (
          <ErrorBox error={carriers.error} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-medium text-ink-2">On-time delivery rate</h3>
              <HBarChart items={onTimeBars} unit="%" color="var(--series-1)" max={100}
                labelWidth={90} valueDigits={0} />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium text-ink-2">Shipment volume</h3>
              <HBarChart items={volumeBars} color="var(--series-2)" labelWidth={90} />
            </div>
            <div className="lg:col-span-2 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-baseline text-left text-xs text-ink-3">
                    <th className="px-2 py-1">Carrier</th>
                    <th className="px-2 py-1 text-right">Shipments</th>
                    <th className="px-2 py-1 text-right">Delivered</th>
                    <th className="px-2 py-1 text-right">On-time %</th>
                    <th className="px-2 py-1 text-right">Late</th>
                    <th className="px-2 py-1 text-right">Cancel %</th>
                    <th className="px-2 py-1 text-right">Avg transit</th>
                    <th className="px-2 py-1 text-right">Data issues %</th>
                    <th className="px-2 py-1 text-right">At risk</th>
                  </tr>
                </thead>
                <tbody>
                  {carrierRows.map((c) => (
                    <tr key={c.carrier} className="border-b border-grid">
                      <td className="whitespace-nowrap px-2 py-1.5 font-medium">{c.carrier}</td>
                      <td className="tnum px-2 py-1.5 text-right">{c.total}</td>
                      <td className="tnum px-2 py-1.5 text-right">{c.delivered}</td>
                      <td className="tnum px-2 py-1.5 text-right"
                          style={{ color: c.on_time_pct == null ? undefined : c.on_time_pct >= 90 ? "var(--status-good)" : c.on_time_pct < 75 ? "var(--status-serious)" : undefined }}>
                        {c.on_time_pct != null ? `${c.on_time_pct}%` : "—"}
                      </td>
                      <td className="tnum px-2 py-1.5 text-right">{c.late}</td>
                      <td className="tnum px-2 py-1.5 text-right">{c.cancel_pct != null ? `${c.cancel_pct}%` : "—"}</td>
                      <td className="tnum px-2 py-1.5 text-right">{c.avg_transit_hours != null ? `${c.avg_transit_hours}h` : "—"}</td>
                      <td className="tnum px-2 py-1.5 text-right"
                          style={{ color: c.issue_pct >= 50 ? "var(--status-serious)" : undefined }}>
                        {c.issue_pct != null ? `${c.issue_pct}%` : "—"}
                      </td>
                      <td className="tnum px-2 py-1.5 text-right"
                          style={{ color: c.at_risk > 0 ? "var(--status-critical)" : undefined }}>{c.at_risk}</td>
                    </tr>
                  ))}
                  {carrierRows.length === 0 && (
                    <tr><td colSpan={9} className="px-2 py-6 text-center text-ink-3">No shipments in this window.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      {/* ---- distributions ------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Delivery status distribution">
          {overview.loading ? <Spinner /> : <Donut data={statusData} />}
        </Panel>
        <Panel title="Mode of transport">
          {overview.loading ? <Spinner /> : <Donut data={modeData} />}
        </Panel>
      </div>

      {/* ---- weekly on-time trend ------------------------------------------ */}
      <Panel title="Weekly delivery outcomes (by injection week)">
        {overview.loading ? (
          <Spinner />
        ) : (
          <>
            <StackedColumns rows={weekly} series={[
              { key: "on_time", label: "On time", color: "var(--status-good)" },
              { key: "late", label: "Late", color: "var(--status-serious)" },
              { key: "other", label: "Delivered (no planned date)", color: "var(--series-3)" },
            ]} />
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-ink-2">
              {[["On time", "var(--status-good)"], ["Late", "var(--status-serious)"],
                ["Delivered (no planned date)", "var(--series-3)"]].map(([l, c]) => (
                <span key={l} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />{l}
                </span>
              ))}
            </div>
          </>
        )}
      </Panel>

      {/* ---- volume breakdowns --------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Volume by region">
          {overview.loading ? <Spinner /> : (
            <HBarChart items={(overview.data!.by_region ?? [])} color="var(--series-1)" labelWidth={90} />
          )}
        </Panel>
        <Panel title="Volume by product">
          {overview.loading ? <Spinner /> : (
            <HBarChart items={(overview.data!.by_product ?? [])} color="var(--series-5)" labelWidth={110} />
          )}
        </Panel>
        <Panel title="Top lanes">
          {overview.loading ? <Spinner /> : (
            <HBarChart items={(overview.data!.top_lanes ?? [])} color="var(--series-2)" labelWidth={180} />
          )}
        </Panel>
      </div>
      <p className="text-center text-[11px] text-ink-3">
        Metrics derived from etl.shipment (routestatus / actualdeliverytime / planneddeliverydate);
        on-time = delivered on or before the planned delivery date.
      </p>
    </div>
  );
}
