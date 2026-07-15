/** Minimal typed fetch layer for the FastAPI backend. */

export type Dict = Record<string, any>;

export interface Issue {
  code: string;
  severity: "critical" | "serious" | "warning" | "info";
  label: string;
  hint: string;
}

export interface ShipmentRow extends Dict {
  trackingnumber: string | null;
  salesordernumber: string | null;
  issues: Issue[];
  issue_count: number;
  max_severity: Issue["severity"] | null;
}

export interface ListResponse {
  total: number;
  page: number;
  page_size: number;
  items: ShipmentRow[];
}

export interface Ping {
  lat: number | null;
  lon: number | null;
  ts: string | null;
  speed_kmh: number | null;
  bearing: number | null;
  dist_km: number | null;
  gap_min: number | null;
  ghost: boolean;
  reasons: string[];
  address: string | null;
  device: string | null;
  tripid: string | null;
}

export interface Airport {
  iata: string;
  name: string;
  municipality: string;
  lat: number;
  lon: number;
  distance_km?: number;
}

export interface FlightSegment {
  from: { lat: number; lon: number; ts: string };
  to: { lat: number; lon: number; ts: string };
  distance_km: number;
  gap_minutes: number;
  implied_speed_kmh: number;
  departure_airport: Airport | null;
  arrival_airport: Airport | null;
  source: string;
}

export interface PingsResponse {
  salesordernumber: string;
  sales_orders?: string[];
  trackingnumber: string | null;
  destination: { lat: number | null; lon: number | null; name: string | null; address: string | null };
  origin: { lat: number | null; lon: number | null; name: string | null; address: string | null };
  reported_flights: Dict[];
  pings: Ping[];
  flight_segments: FlightSegment[];
  summary: Dict;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Short-lived client cache: GET responses are memoized by URL for a few
// seconds so navigating away and back (which unmounts/remounts pages) doesn't
// refetch everything. It also de-dupes concurrent identical requests. Matches
// the server-side aggregate TTLs; per-shipment data is fine at this staleness.
const _apiCache = new Map<string, { t: number; p: Promise<any> }>();
const API_CACHE_MS = 45_000;

/** Drop cached GET responses (call after a mutation, if we ever add one). */
export function clearApiCache() {
  _apiCache.clear();
}

export async function api<T = Dict>(path: string, params?: Dict): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const rel = url.toString().replace(window.location.origin, "");

  const now = Date.now();
  const hit = _apiCache.get(rel);
  if (hit && now - hit.t < API_CACHE_MS) return hit.p as Promise<T>;

  const p = (async () => {
    const res = await fetch(rel);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail ?? JSON.stringify(body).slice(0, 300);
      } catch {
        /* keep statusText */
      }
      throw new ApiError(res.status, detail);
    }
    return res.json();
  })();

  _apiCache.set(rel, { t: now, p });
  // never cache failures — evict so the next call retries
  p.catch(() => {
    if (_apiCache.get(rel)?.p === p) _apiCache.delete(rel);
  });
  return p;
}

/** Parse a possibly offset-less DB timestamp as UTC (matches fmt.ago). */
export function parseTs(v: any): Date | null {
  if (v === null || v === undefined || v === "") return null;
  let str = String(v);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str)) {
    str = str.replace(" ", "T") + "Z";
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

export function haversineKm(
  lat1: number, lon1: number, lat2: number, lon2: number
): number {
  const R = 6371.0088;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dphi = rad(lat2 - lat1);
  const dl = rad(lon2 - lon1);
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const fmt = {
  dt(v: any): string {
    if (v === null || v === undefined || v === "") return "—";
    const s = String(v);
    const d = new Date(s);
    if (isNaN(d.getTime())) return s.slice(0, 19).replace("T", " ");
    return d.toLocaleString(undefined, {
      year: "2-digit", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  },
  date(v: any): string {
    if (v === null || v === undefined || v === "") return "—";
    const s = String(v);
    const d = new Date(s);
    if (isNaN(d.getTime())) return s.slice(0, 10);
    return d.toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
  },
  num(v: any): string {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    if (isNaN(n)) return String(v);
    if (Math.abs(n) >= 10000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
  },
  text(v: any): string {
    const s = v === null || v === undefined ? "" : String(v).trim();
    return s === "" ? "—" : s;
  },
  // compact signed duration between two instants, e.g. "2d 3h" / "45m"
  dur(ms: number | null): string | null {
    if (ms == null || isNaN(ms)) return null;
    const sign = ms < 0 ? "-" : "";
    let s = Math.abs(ms) / 1000;
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return `${sign}${d}d ${h}h`;
    if (h > 0) return `${sign}${h}h ${m}m`;
    return `${sign}${m}m`;
  },
  ago(v: any): string | null {
    if (v === null || v === undefined || v === "") return null;
    let s = String(v);
    // DB timestamps often arrive offset-less ("2026-07-14 09:00:00"); the
    // ETL stores UTC, so parse them as UTC — otherwise every "ago" value is
    // skewed by the viewer's UTC offset.
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
      s = s.replace(" ", "T") + "Z";
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    const sec = (Date.now() - d.getTime()) / 1000;
    if (sec < 0) return null;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h >= 48) return `${Math.floor(h / 24)} days ago`;
    if (h > 0) return `${h} hr ${m} min ago`;
    return `${m} min ago`;
  },
};
