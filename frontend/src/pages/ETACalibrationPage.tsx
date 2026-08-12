import { Link } from "react-router-dom";
import { api, Dict, fmt, TTL } from "../api";
import { ErrorBox, ExportButton, KpiTile, Panel, SEV_COLOR, Spinner, useApi } from "../components/ui";
import { Heatmap, HeatCell } from "../components/charts";

/* Carrier ETA Calibration — correct each live ETA by that carrier's own
   historical delivery bias, then re-check the injection deadline. Flips
   'on-track (raw)' doses to 'at-risk (calibrated)'. */

const VERDICT: Record<string, { label: string; tone: string }> = {
  will_miss_calibrated: { label: "Will miss (calibrated)", tone: "critical" },
  tight_calibrated: { label: "Tight (calibrated)", tone: "serious" },
  on_track: { label: "On track", tone: "good" },
  uncalibrated: { label: "No carrier history", tone: "info" },
};

const hrs = (h: unknown) => {
  if (h == null) return "—";
  const n = Number(h);
  const d = Math.abs(n) >= 48 ? `${(n / 24).toFixed(1)}d` : `${n.toFixed(1)}h`;
  return n > 0 ? `+${d}` : d;
};

export default function ETACalibrationPage() {
  const data = useApi<Dict>(() => api("/api/eta-calibration", undefined, { ttl: TTL.STABLE }), []);
  if (data.loading) return <Spinner label="Learning carrier delivery bias from history…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const s = d.summary ?? {};
  const carriers: Dict[] = d.carriers ?? [];
  const live: Dict[] = d.live ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight">Carrier ETA Calibration</h1>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile label="Flipped by calibration" value={fmt.num(s.flipped)}
          tone={s.flipped > 0 ? "critical" : "good"} sub="looked on-track → will miss" />
        <KpiTile label="Will miss (calibrated)" value={fmt.num(s.will_miss)}
          tone={s.will_miss > 0 ? "critical" : "good"} sub="corrected ETA past deadline" />
        <KpiTile label="Newly tight" value={fmt.num(s.tightened)}
          tone={s.tightened > 0 ? "serious" : "good"} sub="<12h corrected slack" />
        <KpiTile label="Carriers profiled" value={fmt.num(s.carriers_profiled)}
          sub={`≥${d.params?.min_samples ?? 3} deliveries`} />
        <KpiTile label="No history" value={fmt.num(s.uncalibrated)}
          sub="carrier/lane too thin" />
      </div>

      <Panel
        title="Live doses — bias-corrected forecast"
        right={<ExportButton filename="eta-calibration" rows={live} columns={[
          "salesordernumber", "trackingnumber", "carrier", "mode", "injection_deadline",
          "carrier_eta", "calibrated_eta", "bias_h", "slack_raw_h", "slack_calibrated_h", "verdict", "flipped",
        ]} />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-baseline text-left text-xs text-ink-3">
                <th className="px-2 py-1">Tracking / SO</th>
                <th className="px-2 py-1">Carrier · mode</th>
                <th className="px-2 py-1">Injection by</th>
                <th className="px-2 py-1 text-right">Carrier ETA slack</th>
                <th className="px-2 py-1 text-center">Bias</th>
                <th className="px-2 py-1 text-right">Calibrated slack</th>
                <th className="px-2 py-1">Assessment</th>
              </tr>
            </thead>
            <tbody>
              {live.map((r, i) => {
                const v = VERDICT[r.verdict] ?? VERDICT.uncalibrated;
                const cal = r.slack_calibrated_h;
                return (
                  <tr key={i} className="border-b border-grid">
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Link className="font-medium text-s1 hover:underline"
                        to={`/shipment/${encodeURIComponent(String(r.trackingnumber || r.salesordernumber))}`}>
                        {r.trackingnumber || `SO ${r.salesordernumber}`}
                      </Link>
                      {r.flipped && (
                        <span className="ml-1.5 rounded px-1 py-0.5 text-[10px] font-semibold"
                          style={{ background: `color-mix(in srgb, ${SEV_COLOR.critical} 18%, transparent)`, color: "var(--text-primary)" }}>
                          FLIPPED
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">
                      {fmt.text(r.carrier)} <span className="text-ink-3">· {fmt.text(r.mode)}</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tnum">{fmt.dt(r.injection_deadline)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tnum text-ink-3">{hrs(r.slack_raw_h)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-center tnum">
                      {r.bias_h == null ? <span className="text-ink-3">—</span> : (
                        <span style={{ color: Number(r.bias_h) > 0 ? SEV_COLOR.critical : "var(--text-muted)" }}>
                          {hrs(r.bias_h)}{r.spread_h ? <span className="text-ink-3"> ±{Math.round(r.spread_h)}</span> : null}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tnum font-medium"
                      style={{ color: cal == null ? undefined : cal < 0 ? SEV_COLOR.critical : cal < 12 ? SEV_COLOR.serious : "var(--status-good)" }}>
                      {hrs(cal)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span className="inline-flex items-center gap-1 text-xs">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEV_COLOR[v.tone] }} />
                        {v.label}{r.miss_vial ? " · vial" : ""}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {live.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-6 text-center text-sm" style={{ color: "var(--status-good)" }}>
                  ✓ No active doses in the injection window.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Carrier delivery bias — median hours late (red) / early (green)">
        <Heatmap
          diverging
          mid={0}
          rowLabelWidth={110}
          format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}h`}
          rows={[...new Set(carriers.map((c) => String(c.carrier)))]}
          cols={[...new Set(carriers.map((c) => String(c.mode)))]}
          cells={carriers.map((c): HeatCell => ({
            row: String(c.carrier),
            col: String(c.mode),
            value: Number(c.median_bias_h),
            title: `${c.carrier} · ${c.mode}: ${Number(c.median_bias_h) > 0 ? "+" : ""}${c.median_bias_h}h bias · ${c.on_time_pct}% on-time · n=${c.n}${c.trusted ? "" : " (thin sample)"}`,
          }))}
        />
        {carriers.length === 0 && <div className="text-sm text-ink-3">No delivered history in the window.</div>}
      </Panel>
    </div>
  );
}

