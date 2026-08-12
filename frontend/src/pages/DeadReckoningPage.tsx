import { Link } from "react-router-dom";
import { api, Dict, fmt } from "../api";
import { ErrorBox, KpiTile, Panel, SEV_COLOR, Spinner, useApi } from "../components/ui";

/* Dead-Reckoning ETA & Stall board — an independent, GPS-derived ETA from
   closing speed toward destination, plus stall / wrong-way detection that the
   carrier ETA and ghost detection both miss. */

const VERDICT: Record<string, { label: string; tone: string; hint: string }> = {
  stalled: { label: "Stalled", tone: "critical", hint: "pinging but not progressing" },
  moving_wrong_way: { label: "Moving wrong way", tone: "critical", hint: "moving, but not toward destination" },
  will_miss_gps: { label: "Will miss (GPS ETA)", tone: "critical", hint: "GPS ETA past the deadline" },
  gps_stale: { label: "GPS signal lost", tone: "serious", hint: "no recent ping" },
  no_closing: { label: "No progress signal", tone: "serious", hint: "can't derive a closing speed" },
  on_track: { label: "On track", tone: "good", hint: "GPS ETA beats the deadline" },
  insufficient_gps: { label: "No GPS trail", tone: "info", hint: "not enough fixes to dead-reckon" },
};

const hrs = (h: unknown) => {
  if (h == null) return "—";
  const n = Number(h);
  const s = Math.abs(n) >= 48 ? `${(n / 24).toFixed(1)}d` : `${n.toFixed(1)}h`;
  return n > 0 ? `+${s}` : s;
};

export default function DeadReckoningPage() {
  const data = useApi<Dict>(() => api("/api/dead-reckoning"), []);
  if (data.loading) return <Spinner label="Dead-reckoning from the GPS trail…" />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const s = d.summary ?? {};
  const items: Dict[] = d.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Dead-Reckoning ETA &amp; Stall board</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-ink-3">
          An independent ETA computed straight from the GPS trail — closing speed (how fast distance-to-
          destination is shrinking) gives remaining distance ÷ speed, owing nothing to the carrier's promise.
          It also catches doses <em>moving but not toward the patient</em> and ones <em>stalled in place</em>,
          which the carrier ETA and ghost detection both miss.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="GPS-tracked" value={fmt.num(s.tracked)} sub="departed, ≥2 fixes" />
        <KpiTile label="Stalled" value={fmt.num(s.stalled)} tone={s.stalled > 0 ? "critical" : "good"}
          sub="stuck in place" />
        <KpiTile label="Wrong way" value={fmt.num(s.wrong_way)} tone={s.wrong_way > 0 ? "critical" : "good"}
          sub="not toward patient" />
        <KpiTile label="Will miss (GPS)" value={fmt.num(s.will_miss_gps)} tone={s.will_miss_gps > 0 ? "critical" : "good"}
          sub="GPS ETA past deadline" />
        <KpiTile label="GPS lost" value={fmt.num(s.gps_stale)} tone={s.gps_stale > 0 ? "serious" : "good"}
          sub={`no ping >${d.gps_stale_hours}h`} />
        <KpiTile label="On track" value={fmt.num(s.on_track)} tone="good" sub="GPS ETA beats deadline" />
      </div>

      <Panel title="In-transit doses — independent GPS forecast (most urgent first)">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-baseline text-left text-xs text-ink-3">
                <th className="px-2 py-1">Tracking / SO</th>
                <th className="px-2 py-1">Carrier</th>
                <th className="px-2 py-1 text-right">Closing speed</th>
                <th className="px-2 py-1">Progress</th>
                <th className="px-2 py-1 text-right">Remaining</th>
                <th className="px-2 py-1 tnum">GPS ETA</th>
                <th className="px-2 py-1 tnum">Deadline</th>
                <th className="px-2 py-1 text-right">GPS slack</th>
                <th className="px-2 py-1">Assessment</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => {
                const v = VERDICT[r.verdict] ?? VERDICT.insufficient_gps;
                const closing = r.closing_kmh;
                const slack = r.gps_slack_h;
                const wrong = r.verdict === "moving_wrong_way";
                return (
                  <tr key={i} className="border-b border-grid">
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Link className="font-medium text-s1 hover:underline"
                        to={`/shipment/${encodeURIComponent(String(r.trackingnumber || r.salesordernumber))}`}>
                        {r.trackingnumber || `SO ${r.salesordernumber}`}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{fmt.text(r.carrier)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tnum"
                      style={{ color: closing == null ? undefined : Number(closing) < 0 ? SEV_COLOR.critical
                        : Number(closing) < 1 ? SEV_COLOR.serious : "var(--text-secondary)" }}>
                      {closing == null ? "—" : `${Number(closing).toFixed(0)} km/h`}
                      {wrong && " ✗"}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.route_pct == null ? <span className="text-ink-3">—</span> : (
                        <span className="flex items-center gap-1.5">
                          <span className="relative h-2 w-16 overflow-hidden rounded-full bg-grid">
                            <span className="absolute inset-y-0 left-0 rounded-full"
                              style={{ width: `${r.route_pct}%`, background: wrong ? SEV_COLOR.critical : "var(--series-1)" }} />
                          </span>
                          <span className="tnum text-[11px] text-ink-3">{fmt.num(r.route_pct)}%</span>
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tnum text-ink-2">
                      {r.remaining_km == null ? "—" : `${fmt.num(r.remaining_km)} km`}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tnum">{r.gps_eta ? fmt.dt(r.gps_eta) : "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 tnum text-ink-3">{fmt.dt(r.injection_deadline)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tnum font-medium"
                      style={{ color: slack == null ? undefined : slack < 0 ? SEV_COLOR.critical : slack < 12 ? SEV_COLOR.serious : "var(--status-good)" }}>
                      {hrs(slack)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span className="inline-flex items-center gap-1 text-xs" title={v.hint}>
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEV_COLOR[v.tone] }} />
                        {v.label}
                        {r.verdict === "stalled" && r.stall_hours != null && (
                          <span className="text-ink-3"> {fmt.num(r.stall_hours)}h</span>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={9} className="px-2 py-6 text-center text-sm" style={{ color: "var(--status-good)" }}>
                  ✓ No departed doses with a GPS trail in the window.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          Closing speed = rate the straight-line distance to destination is shrinking (negative ✗ = moving
          away). GPS ETA = remaining distance ÷ recent closing speed; slack is against the injection deadline.
          Independent of the carrier's ETA.
        </p>
      </Panel>
    </div>
  );
}
