import { Link } from "react-router-dom";
import { api, Dict, fmt } from "../api";
import { ErrorBox, KpiTile, Panel, SEV_COLOR, Spinner, useApi } from "../components/ui";

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
  const data = useApi<Dict>(() => api("/api/eta-calibration"), []);
  if (data.loading) return <Spinner label="Learning carrier delivery bias from history…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const s = d.summary ?? {};
  const carriers: Dict[] = d.carriers ?? [];
  const live: Dict[] = d.live ?? [];
  const maxBias = Math.max(24, ...carriers.map((c) => Math.abs(Number(c.p90_bias_h) || 0)));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Carrier ETA Calibration</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-ink-3">
          Each carrier's live ETA is corrected by its own historical delivery bias on that lane. A carrier
          that's chronically optimistic quietly turns 'on-track' doses into missed injections — this
          re-forecasts the deadline so those flips surface while there's still time to expedite.
        </p>
      </div>

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

      <Panel title="Live doses — bias-corrected forecast (most urgent first)">
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

      <Panel title="Carrier delivery bias — learned from delivered history">
        <p className="mb-2 text-xs text-ink-3">
          Median delivery error vs the promised ETA (▸ right = runs late / optimistic). Bar shows median;
          whisker to p90. Carriers below the sample threshold are shown but not applied to live forecasts.
        </p>
        <div className="flex flex-col gap-1.5">
          {carriers.map((c) => (
            <BiasRow key={`${c.carrier}-${c.mode}`} c={c} maxBias={maxBias} />
          ))}
          {carriers.length === 0 && <div className="text-sm text-ink-3">No delivered history in the window.</div>}
        </div>
      </Panel>
    </div>
  );
}

/* diverging bias bar centered at 0: right (red) = late, left (green) = early */
function BiasRow({ c, maxBias }: { c: Dict; maxBias: number }) {
  const median = Number(c.median_bias_h) || 0;
  const p90 = Number(c.p90_bias_h) || 0;
  const pct = (h: number) => (Math.max(-maxBias, Math.min(maxBias, h)) / maxBias) * 50; // -50..50 %
  const late = median > 0;
  return (
    <div className="grid items-center gap-2" style={{ gridTemplateColumns: "170px 1fr 210px" }}>
      <div className="min-w-0">
        <span className="text-[13px] font-medium">{fmt.text(c.carrier)}</span>
        <span className="ml-1 text-[11px] text-ink-3">{fmt.text(c.mode)}</span>
        {!c.trusted && <span className="ml-1 text-[10px] text-ink-3">(n={c.n})</span>}
      </div>
      <div className="relative h-5">
        <span className="absolute inset-y-0 left-1/2 w-px bg-baseline" />
        {/* p90 whisker */}
        <span className="absolute top-1/2 h-[2px] -translate-y-1/2"
          style={{ left: `${50 + Math.min(0, pct(p90))}%`, width: `${Math.abs(pct(p90) - pct(0))}%`, background: "var(--grid)" }} />
        {/* median bar from center */}
        <span className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm"
          style={{
            left: `${50 + Math.min(0, pct(median))}%`,
            width: `${Math.max(1, Math.abs(pct(median)))}%`,
            background: late ? SEV_COLOR.critical : "var(--status-good)",
          }} />
      </div>
      <div className="flex items-center justify-end gap-2 text-[11px] text-ink-3">
        <span className="tnum font-medium" style={{ color: late ? SEV_COLOR.critical : "var(--status-good)" }}>
          {median > 0 ? "+" : ""}{median.toFixed(1)}h
        </span>
        <span>·</span>
        <span className="tnum">{fmt.num(c.on_time_pct)}% on-time</span>
        <span>·</span>
        <span className="tnum">n={c.n}</span>
      </div>
    </div>
  );
}
