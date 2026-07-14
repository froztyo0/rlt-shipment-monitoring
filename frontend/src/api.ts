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

export async function api<T = Dict>(path: string, params?: Dict): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString().replace(window.location.origin, ""));
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
  ago(v: any): string | null {
    if (v === null || v === undefined || v === "") return null;
    const d = new Date(String(v));
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
