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
const dotIcon = (color: string, pulse = false, size = 12) =>
  L.divIcon({
    className: "",
    html: `<div style="position:relative;width:${size}px;height:${size}px">
      ${pulse ? `<span class="map-pulse-ring" style="position:absolute;inset:0;border-radius:9999px;background:${color}"></span>` : ""}
      <span style="position:absolute;inset:0;border-radius:9999px;background:${color};border:2px solid var(--surface-1)"></span>
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

// small rotated aircraft triangle (points along heading), no background chrome
const planeIcon = (rotate: number) =>
  L.divIcon({
    className: "",
    html: `<svg width="22" height="22" viewBox="0 0 24 24" style="transform:rotate(${rotate}deg);overflow:visible">
      <path d="M12 2 L19 20 L12 15.5 L5 20 Z" fill="var(--series-5)" stroke="var(--surface-1)" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

// small diamond for an airport node
const airportIcon = L.divIcon({
  className: "",
  html: `<span style="display:block;width:9px;height:9px;background:var(--series-5);
    border:1.5px solid var(--surface-1);transform:rotate(45deg)"></span>`,
  iconSize: [11, 11],
  iconAnchor: [5.5, 5.5],
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

  // current-position marker (minimal): pulsing dot while in transit, solid on delivery
  const currentMarker = (() => {
    if (!lastClean || flight) return null; // airborne handled by MovingPlane
    if (delivered) return dotIcon("var(--status-good)", false, 13);
    return dotIcon(roadMode ? "var(--series-4)" : "var(--series-1)", true, 13);
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
        <Marker position={[data.origin.lat, data.origin.lon!]} icon={dotIcon("var(--series-4)", false, 12)}>
          <Tooltip direction="right" offset={[6, 0]} className="map-label">Origin</Tooltip>
          <Popup><b>{data.origin.name}</b><br />{data.origin.address}</Popup>
        </Marker>
      )}
      {data.destination.lat != null && (
        <Marker position={[data.destination.lat, data.destination.lon!]} icon={dotIcon("var(--status-critical)", false, 12)}>
          <Tooltip direction="right" offset={[6, 0]} className="map-label">Destination</Tooltip>
          <Popup><b>{data.destination.name}</b><br />{data.destination.address}</Popup>
        </Marker>
      )}
    </MapContainer>
  );
}
