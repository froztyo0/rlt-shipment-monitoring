import { ReactNode } from "react";

/* Lightweight, theme-aware SVG charts built on the dataviz palette tokens
   (--series-*, status colors). Thin marks, rounded data-ends, 2px surface
   gaps, legends for >=2 series, direct value labels, native hover titles. */

export const SERIES = [
  "var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)",
  "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)",
];

export interface Datum {
  label: string;
  value: number;
  color?: string;
}

const fmtNum = (n: number) =>
  Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString();

/* ---- horizontal bar chart (magnitude / ranking) --------------------------- */
export function HBarChart({
  items, unit = "", color = "var(--series-1)", max, labelWidth = 150, valueDigits,
}: {
  items: Datum[];
  unit?: string;
  color?: string;
  max?: number;
  labelWidth?: number;
  valueDigits?: number;
}) {
  const hi = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((i) => {
        const val = valueDigits != null ? i.value.toFixed(valueDigits) : fmtNum(i.value);
        return (
          <div key={i.label} className="grid items-center gap-2"
               style={{ gridTemplateColumns: `${labelWidth}px 1fr 52px` }}>
            <span className="truncate text-xs text-ink-2" title={i.label}>{i.label}</span>
            <span className="relative h-[15px]" title={`${i.label}: ${val}${unit}`}>
              <span className="absolute inset-y-0 left-0 w-full rounded-[3px] bg-grid opacity-40" />
              <span className="absolute inset-y-0 left-0 rounded-r-[4px]"
                    style={{ width: `${Math.max(1.5, (i.value / hi) * 100)}%`, background: i.color ?? color }} />
            </span>
            <span className="tnum text-right text-xs text-ink-2">{val}{unit}</span>
          </div>
        );
      })}
      {items.length === 0 && <div className="text-xs text-ink-3">No data in this window.</div>}
    </div>
  );
}

/* ---- donut (part-to-whole) ------------------------------------------------ */
export function Donut({
  data, size = 168, thickness = 22, center,
}: {
  data: Datum[];
  size?: number;
  thickness?: number;
  center?: ReactNode;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const gap = total > 0 ? 2 : 0; // 2px surface gap between segments
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                  stroke="var(--grid)" strokeOpacity={0.4} strokeWidth={thickness} />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {total > 0 && data.filter((d) => d.value > 0).map((d, i) => {
              const arc = (d.value / total) * c;
              const seg = Math.max(0, arc - gap);
              const el = (
                <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
                        stroke={d.color ?? SERIES[i % SERIES.length]} strokeWidth={thickness}
                        strokeDasharray={`${seg} ${c - seg}`} strokeDashoffset={-offset}>
                  <title>{`${d.label}: ${fmtNum(d.value)} (${Math.round((d.value / total) * 100)}%)`}</title>
                </circle>
              );
              offset += arc;
              return el;
            })}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {center ?? (
            <>
              <span className="text-xl font-semibold">{fmtNum(total)}</span>
              <span className="text-[10px] text-ink-3">total</span>
            </>
          )}
        </div>
      </div>
      <Legend data={data} total={total} />
    </div>
  );
}

export function Legend({ data, total }: { data: Datum[]; total?: number }) {
  const sum = total ?? data.reduce((s, d) => s + d.value, 0);
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {data.map((d, i) => (
        <li key={d.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[3px]"
                style={{ background: d.color ?? SERIES[i % SERIES.length] }} />
          <span className="text-ink-2">{d.label}</span>
          <span className="tnum ml-auto pl-3 text-ink-3">
            {fmtNum(d.value)}{sum ? ` · ${Math.round((d.value / sum) * 100)}%` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---- stacked columns (change over time) ----------------------------------- */
export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

export function StackedColumns({
  rows, series, height = 170,
}: {
  rows: { label: string; values: Record<string, number> }[];
  series: StackSeries[];
  height?: number;
}) {
  const totals = rows.map((r) => series.reduce((s, k) => s + (r.values[k.key] || 0), 0));
  const hi = Math.max(1, ...totals);
  const gap = 2;
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {rows.map((r, ri) => {
          const total = totals[ri];
          return (
            <div key={r.label} className="flex flex-1 flex-col items-center justify-end gap-1"
                 style={{ height: "100%" }}>
              <span className="tnum text-[10px] text-ink-3">{total || ""}</span>
              <div className="flex w-full max-w-[38px] flex-col justify-end"
                   style={{ height: `${(total / hi) * 100}%`, minHeight: total ? 2 : 0 }}>
                {series.map((k, ki) => {
                  const v = r.values[k.key] || 0;
                  if (!v) return null;
                  return (
                    <div key={k.key} title={`${r.label} · ${k.label}: ${v}`}
                         style={{
                           height: `${(v / total) * 100}%`,
                           background: k.color,
                           marginTop: ki > 0 ? gap : 0,
                           borderTopLeftRadius: ki === 0 ? 4 : 0,
                           borderTopRightRadius: ki === 0 ? 4 : 0,
                         }} />
                  );
                })}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <div className="text-xs text-ink-3">No data in this window.</div>}
      </div>
      <div className="mt-1 flex gap-2">
        {rows.map((r) => (
          <span key={r.label} className="flex-1 truncate text-center text-[10px] text-ink-3" title={r.label}>
            {r.label.slice(5)}
          </span>
        ))}
      </div>
    </div>
  );
}
