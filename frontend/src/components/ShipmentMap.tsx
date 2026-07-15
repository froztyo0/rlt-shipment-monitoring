import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip } from "react-leaflet";
import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { fmt, haversineKm, PingsResponse } from "../api";

/* ---- theme-aware Carto basemap -------------------------------------------- */
function useIsDark(): boolean {
  const read = () => {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = () => setDark(read());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", update);
    return () => { mo.disconnect(); mq?.removeEventListener?.("change", update); };
  }, []);
  return dark;
}

/* ---- minimal icons -------------------------------------------------------- */
// clean filled dot; optional live pulse ring
const SHADOW = "filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))";

// clean filled dot (used for GPS pings / origin)
const dotIcon = (color: string, pulse = false, size = 13) =>
  L.divIcon({
    className: "",
    html: `<div style="position:relative;width:${size}px;height:${size}px">
      ${pulse ? `<span class="map-pulse-ring" style="position:absolute;inset:0;border-radius:9999px;background:${color}"></span>` : ""}
      <span style="position:absolute;inset:0;border-radius:9999px;background:${color};border:2px solid var(--surface-1)"></span>
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

// top-down aircraft silhouette, rotated to heading
const planeIcon = (rotate: number) =>
  L.divIcon({
    className: "",
    html: `<svg width="30" height="30" viewBox="0 0 24 24" style="transform:rotate(${rotate}deg);${SHADOW}">
      <path d="M12 2c.8 0 1.3.9 1.3 2.7V9l7.2 4.2v1.9l-7.2-2v3.9l2 1.4v1.5L12 20.4 8.7 21.8v-1.5l2-1.4v-3.9l-7.2 2v-1.9L10.7 9V4.7C10.7 2.9 11.2 2 12 2z"
        fill="var(--series-5)" stroke="#fff" stroke-width="0.7" stroke-linejoin="round"/>
    </svg>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

// delivery-truck silhouette (current ground position)
const truckIcon = (color: string, pulse = true) =>
  L.divIcon({
    className: "",
    html: `<div style="position:relative;width:32px;height:32px;display:flex;align-items:center;justify-content:center">
      ${pulse ? `<span class="map-pulse-ring" style="position:absolute;left:9px;top:9px;width:14px;height:14px;border-radius:9999px;background:${color}"></span>` : ""}
      <svg width="27" height="27" viewBox="0 0 24 24" style="${SHADOW};position:relative">
        <rect x="1.5" y="6.5" width="12" height="8.5" rx="1" fill="${color}" stroke="#fff" stroke-width="0.8"/>
        <path d="M13.5 9h3.7l2.8 2.8V15h-6.5z" fill="${color}" stroke="#fff" stroke-width="0.8" stroke-linejoin="round"/>
        <circle cx="6" cy="16.8" r="2.4" fill="#141414" stroke="#fff" stroke-width="1"/>
        <circle cx="16" cy="16.8" r="2.4" fill="#141414" stroke="#fff" stroke-width="1"/>
      </svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

// airport: violet rounded badge with a plane glyph
const airportIcon = L.divIcon({
  className: "",
  html: `<div style="width:22px;height:22px;background:var(--series-5);border-radius:5px;
    display:flex;align-items:center;justify-content:center;border:1.5px solid var(--surface-1);${SHADOW}">
    <svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 3c.6 0 1 .8 1 2.2V9l6 3.5v1.5l-6-1.7v3.3l1.6 1.2v1.2L12 17.7 9.4 18.2v-1.2L11 15.8v-3.3l-6 1.7V12.5L11 9V5.2C11 3.8 11.4 3 12 3z" fill="#fff"/></svg>
  </div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

// destination: red map pin (tip anchored at the location)
const destIcon = L.divIcon({
  className: "",
  html: `<svg width="26" height="34" viewBox="0 0 24 32" style="${SHADOW}">
    <path d="M12 1C6.9 1 3 5 3 10c0 6.6 9 21 9 21s9-14.4 9-21c0-5-3.9-9-9-9z"
      fill="var(--status-critical)" stroke="#fff" stroke-width="1"/>
    <circle cx="12" cy="10" r="3.4" fill="#fff"/>
  </svg>`,
  iconSize: [26, 34],
  iconAnchor: [13, 32],
});

// delivered: green check badge
const deliveredIcon = L.divIcon({
  className: "",
  html: `<div style="width:24px;height:24px;background:var(--status-good);border-radius:9999px;
    display:flex;align-items:center;justify-content:center;border:2px solid var(--surface-1);${SHADOW};
    color:#fff;font-size:14px;font-weight:700;line-height:1">✓</div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

export const plottable = (lat: number | null, lon: number | null) =>
  lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
  !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6); // (0,0) = null island

function bearingDeg(a: LL, b: LL): number {
  const toR = (x: number) => (x * Math.PI) / 180, toD = (x: number) => (x * 180) / Math.PI;
  const y = Math.sin(toR(b.lon - a.lon)) * Math.cos(toR(b.lat));
  const x = Math.cos(toR(a.lat)) * Math.sin(toR(b.lat)) -
    Math.sin(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.cos(toR(b.lon - a.lon));
  return (toD(Math.atan2(y, x)) + 360) % 360;
}

type LL = { lat: number; lon: number };

export interface MapLayers {
  trail: boolean;
  pings: boolean;
  ghosts: boolean;
  airports: boolean;
  planned: boolean;
}
const ALL_LAYERS: MapLayers = { trail: true, pings: true, ghosts: true, airports: true, planned: true };

/* ---- animated "predicted" in-flight airplane ------------------------------ */
function MovingPlane({ from, to }: { from: LL; to: LL }) {
  const [frac, setFrac] = useState(0);
  useEffect(() => {
    // loop the leg so the aircraft is visibly moving (predicted position)
    const id = setInterval(() => setFrac((f) => (f >= 1 ? 0 : f + 0.008)), 60);
    return () => clearInterval(id);
  }, [from.lat, from.lon, to.lat, to.lon]);

  const pos: [number, number] = [from.lat + (to.lat - from.lat) * frac, from.lon + (to.lon - from.lon) * frac];
  const brng = bearingDeg(from, to);
  return (
    <>
      {/* flown-so-far (solid, subtle) + remaining (dashed, subtler) */}
      <Polyline positions={[[from.lat, from.lon], pos]}
        pathOptions={{ color: "var(--series-5)", weight: 2, opacity: 0.85 }} />
      <Polyline positions={[pos, [to.lat, to.lon]]}
        pathOptions={{ color: "var(--series-5)", weight: 1.5, dashArray: "2 6", opacity: 0.45 }} />
      <Marker position={pos} icon={planeIcon(brng)} zIndexOffset={1000}>
        <Tooltip direction="top" className="map-label">in flight · predicted</Tooltip>
      </Marker>
    </>
  );
}

export default function ShipmentMap({
  data, layers, visibleCount, delivered = false, roadMode = false,
}: {
  data: PingsResponse;
  layers?: Partial<MapLayers>;
  visibleCount?: number | null;
  delivered?: boolean;
  roadMode?: boolean;
}) {
  const dark = useIsDark();
  const L_ = { ...ALL_LAYERS, ...(layers ?? {}) };
  const allClean = data.pings.filter((p) => !p.ghost && plottable(p.lat, p.lon));
  const clean = visibleCount == null ? allClean : allClean.slice(0, Math.max(0, visibleCount));
  const ghosts = data.pings.filter((p) => p.ghost && plottable(p.lat, p.lon));
  const lastClean = clean[clean.length - 1];

  // planned route: origin → airports (reported first, else inferred) → destination
  const plannedRoute = useMemo(() => {
    const pts: [number, number][] = [];
    const push = (lat?: number | null, lon?: number | null) => {
      if (lat == null || lon == null) return;
      const last = pts[pts.length - 1];
      if (!last || last[0] !== lat || last[1] !== lon) pts.push([lat, lon]);
    };
    push(data.origin.lat, data.origin.lon);
    const flights = data.reported_flights.length ? data.reported_flights : [];
    if (flights.length) {
      for (const f of flights) {
        push(f.departure_airport?.lat, f.departure_airport?.lon);
        push(f.arrival_airport?.lat, f.arrival_airport?.lon);
      }
    } else {
      for (const seg of data.flight_segments) {
        push(seg.departure_airport?.lat, seg.departure_airport?.lon);
        push(seg.arrival_airport?.lat, seg.arrival_airport?.lon);
      }
    }
    push(data.destination.lat, data.destination.lon);
    return pts;
  }, [data]);

  // is the shipment airborne *right now*? (departed an airport, not yet arrived)
  const flight = useMemo(() => {
    const rep = data.reported_flights.find((f) => f.arrival_airport || f.departure_airport);
    const lastSeg = data.flight_segments.length ? data.flight_segments[data.flight_segments.length - 1] : null;
    const arr: LL | null = rep?.arrival_airport
      ? { lat: rep.arrival_airport.lat, lon: rep.arrival_airport.lon }
      : lastSeg?.arrival_airport
        ? { lat: lastSeg.arrival_airport.lat, lon: lastSeg.arrival_airport.lon }
        : (data.destination.lat != null ? { lat: data.destination.lat, lon: data.destination.lon } : null);
    const dep: LL | null = rep?.departure_airport
      ? { lat: rep.departure_airport.lat, lon: rep.departure_airport.lon }
      : data.flight_segments[0]?.departure_airport
        ? { lat: data.flight_segments[0].departure_airport!.lat, lon: data.flight_segments[0].departure_airport!.lon }
        : (lastClean ? { lat: lastClean.lat!, lon: lastClean.lon! } : null);
    const hasAir = data.reported_flights.length > 0 || data.flight_segments.length > 0;
    if (delivered || !hasAir || !arr || !dep) return null;
    // arrived if the latest fix is already near the arrival point
    const near = lastClean && haversineKm(lastClean.lat!, lastClean.lon!, arr.lat, arr.lon) < 40;
    if (near) return null;
    return { dep, arr };
  }, [data, delivered, lastClean]);

  const bounds = useMemo(() => {
    const pts: [number, number][] = allClean.map((p) => [p.lat!, p.lon!]);
    if (data.destination.lat != null) pts.push([data.destination.lat, data.destination.lon!]);
    if (data.origin.lat != null) pts.push([data.origin.lat, data.origin.lon!]);
    for (const g of ghosts) pts.push([g.lat!, g.lon!]);
    for (const seg of data.flight_segments)
      for (const a of [seg.departure_airport, seg.arrival_airport]) if (a) pts.push([a.lat, a.lon]);
    return pts.length ? L.latLngBounds(pts).pad(0.15) : L.latLngBounds([[0, 0], [1, 1]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const trail: [number, number][] = clean.map((p) => [p.lat!, p.lon!]);

  const airportPins = useMemo(() => {
    const seen = new Map<string, any>();
    for (const seg of data.flight_segments)
      for (const a of [seg.departure_airport, seg.arrival_airport])
        if (a?.iata) seen.set(a.iata, { ...a, source: "inferred" });
    for (const rf of data.reported_flights)
      for (const a of [rf.departure_airport, rf.arrival_airport])
        if (a?.iata) seen.set(a.iata, { ...a, source: "carrier-reported" });
    return [...seen.values()];
  }, [data]);

  const cartoUrl = dark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

  // current-position marker: truck on the ground, ✓ when delivered
  // (airborne is handled by the animated MovingPlane)
  const currentMarker = (() => {
    if (!lastClean || flight) return null;
    if (delivered) return deliveredIcon;
    return truckIcon(roadMode ? "var(--series-4)" : "var(--series-1)", true);
  })();
  const currentLabel = delivered ? "delivered" : roadMode ? "on road" : "current";

  return (
    <MapContainer bounds={bounds} className="h-[480px] w-full rounded-md" scrollWheelZoom>
      <TileLayer
        key={dark ? "dark" : "light"}
        attribution='&copy; <a href="https://carto.com/">CARTO</a> · &copy; OpenStreetMap'
        url={cartoUrl}
        subdomains="abcd"
      />

      {L_.planned && plannedRoute.length >= 2 && (
        <Polyline positions={plannedRoute}
          pathOptions={{ color: "var(--text-muted)", weight: 1.5, dashArray: "1 7", opacity: 0.55 }}>
          <Tooltip sticky className="map-label">planned route</Tooltip>
        </Polyline>
      )}

      {L_.trail && trail.length >= 2 && (
        <Polyline positions={trail} pathOptions={{ color: "var(--series-1)", weight: 2, opacity: 0.9 }} />
      )}

      {L_.trail && data.flight_segments.map((seg, i) => (
        <Polyline key={`seg-${i}`}
          positions={[[seg.from.lat, seg.from.lon], [seg.to.lat, seg.to.lon]]}
          pathOptions={{ color: "var(--series-5)", weight: 1.5, dashArray: "5 6", opacity: 0.55 }}>
          <Tooltip sticky className="map-label">
            air leg · {seg.distance_km} km
            {seg.departure_airport && <> · {seg.departure_airport.iata}→{seg.arrival_airport?.iata ?? "?"}</>}
          </Tooltip>
        </Polyline>
      ))}

      {/* animated predicted airplane while in flight */}
      {flight && <MovingPlane from={flight.dep} to={flight.arr} />}

      {/* clean pings */}
      {L_.pings && clean.map((p, i) => {
        const isLast = i === clean.length - 1;
        if (isLast && currentMarker) return null; // replaced by truck/✓ marker
        return (
          <CircleMarker key={`p-${i}`} center={[p.lat!, p.lon!]}
            radius={isLast ? 6 : 4}
            pathOptions={{ color: "var(--surface-1)", weight: 2,
              fillColor: isLast ? "var(--status-good)" : "var(--series-1)", fillOpacity: 1 }}>
            <Popup>
              <div style={{ fontSize: 12 }}>
                <b>{isLast ? "Latest fix" : `Ping ${i + 1}`}</b><br />{fmt.dt(p.ts)}
                {p.speed_kmh != null && <><br />speed {p.speed_kmh} km/h · bearing {p.bearing}°</>}
                {p.address && <><br />{p.address}</>}
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {/* current position marker (minimal dot) */}
      {L_.pings && currentMarker && lastClean && (
        <Marker position={[lastClean.lat!, lastClean.lon!]} icon={currentMarker} zIndexOffset={900}>
          <Tooltip direction="top" className="map-label">{currentLabel}</Tooltip>
          <Popup>
            <div style={{ fontSize: 12 }}>
              <b>{delivered ? "Delivered" : "Current position"}</b><br />{fmt.dt(lastClean.ts)}
              {lastClean.address && <><br />{lastClean.address}</>}
            </div>
          </Popup>
        </Marker>
      )}

      {/* ghost pings */}
      {L_.ghosts && ghosts.map((p, i) => (
        <CircleMarker key={`g-${i}`} center={[p.lat!, p.lon!]} radius={6}
          pathOptions={{ color: "var(--surface-1)", weight: 2, fillColor: "var(--status-critical)", fillOpacity: 1 }}>
          <Popup>
            <div style={{ fontSize: 12 }}>
              <b style={{ color: "var(--status-critical)" }}>⛔ Ghost ping</b> — {p.reasons.join(", ")}
              <br />{fmt.dt(p.ts)}
              {p.speed_kmh != null && <><br />implied speed {p.speed_kmh} km/h</>}
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* airports */}
      {L_.airports && airportPins.map((a) => (
        <Marker key={a.iata} position={[a.lat, a.lon]} icon={airportIcon}>
          <Tooltip direction="right" offset={[6, 0]} className="map-label">{a.iata}</Tooltip>
          <Popup>
            <div style={{ fontSize: 12 }}>
              <b>{a.iata}</b> · {a.name}<br />{a.municipality}
              <span style={{ color: "var(--text-muted)" }}> ({a.source})</span>
            </div>
          </Popup>
        </Marker>
      ))}

      {data.origin.lat != null && (
        <Marker position={[data.origin.lat, data.origin.lon!]} icon={dotIcon("var(--series-4)", false, 15)}>
          <Tooltip direction="right" offset={[7, 0]} className="map-label">Origin</Tooltip>
          <Popup><b>{data.origin.name}</b><br />{data.origin.address}</Popup>
        </Marker>
      )}
      {data.destination.lat != null && (
        <Marker position={[data.destination.lat, data.destination.lon!]} icon={destIcon}>
          <Tooltip direction="right" offset={[8, -10]} className="map-label">Destination</Tooltip>
          <Popup><b>{data.destination.name}</b><br />{data.destination.address}</Popup>
        </Marker>
      )}
    </MapContainer>
  );
}
