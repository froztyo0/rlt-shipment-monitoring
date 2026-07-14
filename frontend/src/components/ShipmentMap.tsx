import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip } from "react-leaflet";
import L from "leaflet";
import { useMemo } from "react";
import { fmt, PingsResponse } from "../api";

const airportIcon = L.divIcon({
  className: "",
  html: `<div style="background:var(--series-5);color:#fff;border-radius:6px;padding:1px 5px;font-size:10px;font-weight:600;border:2px solid var(--surface-1);white-space:nowrap">✈</div>`,
  iconSize: [24, 18],
  iconAnchor: [12, 9],
});

const endpointIcon = (label: string, color: string) =>
  L.divIcon({
    className: "",
    html: `<div style="background:${color};color:#fff;border-radius:9999px;padding:2px 7px;font-size:10px;font-weight:700;border:2px solid var(--surface-1);white-space:nowrap">${label}</div>`,
    iconSize: [30, 20],
    iconAnchor: [15, 10],
  });

export const plottable = (lat: number | null, lon: number | null) =>
  lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
  !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6); // (0,0) = null island

export default function ShipmentMap({ data }: { data: PingsResponse }) {
  const clean = data.pings.filter((p) => !p.ghost && plottable(p.lat, p.lon));
  // coordinate-invalid ghosts are unplottable — they live in the ghost table below
  const ghosts = data.pings.filter((p) => p.ghost && plottable(p.lat, p.lon));

  const bounds = useMemo(() => {
    const pts: [number, number][] = clean.map((p) => [p.lat!, p.lon!]);
    if (data.destination.lat != null) pts.push([data.destination.lat, data.destination.lon!]);
    if (data.origin.lat != null) pts.push([data.origin.lat, data.origin.lon!]);
    for (const g of ghosts) pts.push([g.lat!, g.lon!]);
    for (const seg of data.flight_segments) {
      for (const a of [seg.departure_airport, seg.arrival_airport]) {
        if (a) pts.push([a.lat, a.lon]);
      }
    }
    return pts.length ? L.latLngBounds(pts).pad(0.15) : L.latLngBounds([[0, 0], [1, 1]]);
  }, [data]);

  const trail: [number, number][] = clean.map((p) => [p.lat!, p.lon!]);

  const airports = useMemo(() => {
    const seen = new Map<string, any>();
    for (const seg of data.flight_segments) {
      for (const a of [seg.departure_airport, seg.arrival_airport]) {
        if (a?.iata) seen.set(a.iata, { ...a, source: "inferred" });
      }
    }
    for (const rf of data.reported_flights) {
      for (const a of [rf.departure_airport, rf.arrival_airport]) {
        if (a?.iata) seen.set(a.iata, { ...a, source: "carrier-reported" });
      }
    }
    return [...seen.values()];
  }, [data]);

  return (
    <MapContainer bounds={bounds} className="h-[480px] w-full rounded-md" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* travelled trail */}
      {trail.length >= 2 && (
        <Polyline positions={trail} pathOptions={{ color: "var(--series-1)", weight: 2, opacity: 0.9 }} />
      )}

      {/* inferred flight legs — dashed violet */}
      {data.flight_segments.map((seg, i) => (
        <Polyline
          key={`seg-${i}`}
          positions={[[seg.from.lat, seg.from.lon], [seg.to.lat, seg.to.lon]]}
          pathOptions={{ color: "var(--series-5)", weight: 2, dashArray: "6 6", opacity: 0.9 }}
        >
          <Tooltip sticky>
            Air leg (inferred): {seg.distance_km} km in {Math.round(seg.gap_minutes)} min
            (~{Math.round(seg.implied_speed_kmh)} km/h)
            {seg.departure_airport && <> · {seg.departure_airport.iata} → {seg.arrival_airport?.iata ?? "?"}</>}
          </Tooltip>
        </Polyline>
      ))}

      {/* clean pings */}
      {clean.map((p, i) => (
        <CircleMarker
          key={`p-${i}`}
          center={[p.lat!, p.lon!]}
          radius={i === clean.length - 1 ? 7 : 4}
          pathOptions={{
            color: "var(--surface-1)", weight: 2,
            fillColor: i === clean.length - 1 ? "var(--status-good)" : "var(--series-1)",
            fillOpacity: 1,
          }}
        >
          <Popup>
            <div style={{ fontSize: 12 }}>
              <b>{i === clean.length - 1 ? "Latest fix" : `Ping ${i + 1}`}</b>
              <br />{fmt.dt(p.ts)}
              {p.speed_kmh != null && <><br />speed {p.speed_kmh} km/h · bearing {p.bearing}°</>}
              {p.address && <><br />{p.address}</>}
              <br /><span style={{ color: "var(--text-muted)" }}>{p.device}</span>
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* ghost pings */}
      {ghosts.map((p, i) => (
        <CircleMarker
          key={`g-${i}`}
          center={[p.lat!, p.lon!]}
          radius={6}
          pathOptions={{ color: "var(--surface-1)", weight: 2, fillColor: "var(--status-critical)", fillOpacity: 1 }}
        >
          <Popup>
            <div style={{ fontSize: 12 }}>
              <b style={{ color: "var(--status-critical)" }}>⛔ Ghost ping</b> — {p.reasons.join(", ")}
              <br />{fmt.dt(p.ts)}
              {p.speed_kmh != null && <><br />implied speed {p.speed_kmh} km/h</>}
              {p.dist_km != null && <><br />jump {p.dist_km} km in {p.gap_min} min</>}
            </div>
          </Popup>
        </CircleMarker>
      ))}

      {/* airports */}
      {airports.map((a) => (
        <Marker key={a.iata} position={[a.lat, a.lon]} icon={airportIcon}>
          <Popup>
            <div style={{ fontSize: 12 }}>
              <b>{a.iata}</b> · {a.name}
              <br />{a.municipality} <span style={{ color: "var(--text-muted)" }}>({a.source})</span>
            </div>
          </Popup>
        </Marker>
      ))}

      {/* origin / destination */}
      {data.origin.lat != null && (
        <Marker position={[data.origin.lat, data.origin.lon!]} icon={endpointIcon("ORIGIN", "var(--series-4)")}>
          <Popup><b>{data.origin.name}</b><br />{data.origin.address}</Popup>
        </Marker>
      )}
      {data.destination.lat != null && (
        <Marker position={[data.destination.lat, data.destination.lon!]} icon={endpointIcon("DEST", "var(--series-6)")}>
          <Popup><b>{data.destination.name}</b><br />{data.destination.address}</Popup>
        </Marker>
      )}
    </MapContainer>
  );
}
