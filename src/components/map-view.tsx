"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap, GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export interface MapFeature {
  id: string;
  name: string;
  lat: number;
  lng: number;
  progress: string;
  discovery: string;
  approximate: boolean;
  country: string | null;
  city: string | null;
  priority: string;
}

const PROGRESS = [
  ["not_contacted", "Not contacted", "#8a8a85", "N"], ["drafting", "Drafting", "#8a8a85", "D"], ["ready", "Ready", "#2f6fdb", "R"], ["scheduled", "Scheduled", "#2f6fdb", "S"],
  ["contacted", "Awaiting reply", "#c08a00", "A"], ["replied", "Replied", "#7a4fd0", "P"], ["interviewing", "Interview / offer", "#1f8a4c", "I"], ["closed", "Closed", "#c4322a", "X"],
] as const;
const DISCOVERY = [
  ["not_researched", "Not researched", "#8a8a85", "–"], ["searching", "Searching", "#2f6fdb", "…"], ["candidate_found", "Candidate found", "#c08a00", "C"], ["reviewed", "Reviewed", "#1f8a4c", "✓"], ["no_suitable_match", "No suitable match", "#c4322a", "∅"],
] as const;

export function MapView({ features, styleUrl, attribution }: { features: MapFeature[]; styleUrl: string; attribution: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [mode, setMode] = useState<"progress" | "discovery">("progress");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = useMemo(() => features.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()) || (f.city ?? "").toLowerCase().includes(q.toLowerCase())), [features, q]);
  const legend = mode === "progress" ? PROGRESS : DISCOVERY;

  const geojson = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: shown.map((f) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [f.lng, f.lat] }, properties: { id: f.id, name: f.name, progress: f.progress, discovery: f.discovery, approx: f.approximate ? 1 : 0, place: [f.city, f.country].filter(Boolean).join(", ") } })),
  }), [shown]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ml = await import("maplibre-gl");
        ml.setWorkerUrl("/vendor/maplibre-gl-worker.mjs");
        if (cancelled || !el.current) return;
        const m = new ml.Map({ container: el.current, style: styleUrl, center: [20, 30], zoom: 1.3, attributionControl: { compact: false, customAttribution: attribution } });
        map.current = m;
        m.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
        m.on("error", (e) => {
          const msg = String((e as unknown as { error?: { message?: string } }).error?.message ?? "");
          if (/style|tile|fetch|load/i.test(msg)) setError("Map tiles could not be loaded. The list below still works; check the tile provider in Settings.");
        });
        m.on("load", () => {
          m.addSource("companies", { type: "geojson", data: geojson, cluster: true, clusterRadius: 40, clusterMaxZoom: 9 });
          m.addLayer({ id: "clusters", type: "circle", source: "companies", filter: ["has", "point_count"], paint: { "circle-color": "#555", "circle-opacity": 0.75, "circle-radius": ["step", ["get", "point_count"], 14, 20, 18, 100, 24], "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
          m.addLayer({ id: "cluster-count", type: "symbol", source: "companies", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11 }, paint: { "text-color": "#fff" } });
          m.addLayer({ id: "points", type: "circle", source: "companies", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": 7, "circle-color": "#888", "circle-stroke-width": ["case", ["==", ["get", "approx"], 1], 0.5, 2], "circle-stroke-color": "#fff", "circle-opacity": ["case", ["==", ["get", "approx"], 1], 0.55, 0.95] } });
          m.addLayer({ id: "point-code", type: "symbol", source: "companies", filter: ["!", ["has", "point_count"]], layout: { "text-field": "", "text-size": 9, "text-allow-overlap": true }, paint: { "text-color": "#fff" } });
          applyColors(m, "progress");
          m.on("click", "clusters", async (e: MapLayerMouseEvent) => {
            const f = e.features?.[0];
            if (!f) return;
            const src = m.getSource("companies") as GeoJSONSource;
            const zoom = await src.getClusterExpansionZoom(f.properties!.cluster_id as number);
            m.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
          });
          m.on("click", "points", (e: MapLayerMouseEvent) => {
            const p = e.features?.[0]?.properties as Record<string, string | number> | undefined;
            if (!p) return;
            setSelected(String(p.id));
            const div = document.createElement("div");
            const a = document.createElement("a");
            a.href = `/companies/${p.id}`;
            a.textContent = String(p.name);
            a.style.fontWeight = "600";
            const meta = document.createElement("div");
            meta.style.fontSize = "11px";
            meta.textContent = `${p.place}${Number(p.approx) ? " (approximate, country-level)" : ""} · ${String(p.progress).replace(/_/g, " ")}`;
            div.append(a, meta);
            new ml.Popup({ closeButton: true }).setLngLat((e.features![0].geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(div).addTo(m);
          });
          for (const l of ["clusters", "points"]) {
            m.on("mouseenter", l, () => (m.getCanvas().style.cursor = "pointer"));
            m.on("mouseleave", l, () => (m.getCanvas().style.cursor = ""));
          }
          fit(m, geojson.features.map((f) => f.geometry.coordinates as [number, number]));
        });
      } catch {
        setError("The map could not start (WebGL may be unavailable). The list below still works.");
      }
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  useEffect(() => {
    const m = map.current;
    const src = m?.getSource("companies") as GeoJSONSource | undefined;
    src?.setData(geojson);
  }, [geojson]);

  useEffect(() => {
    if (map.current?.getLayer("points")) applyColors(map.current, mode);
  }, [mode]);

  function applyColors(m: MlMap, md: "progress" | "discovery") {
    const table = md === "progress" ? PROGRESS : DISCOVERY;
    const key = md === "progress" ? "progress" : "discovery";
    const color: unknown[] = ["match", ["get", key]];
    const code: unknown[] = ["match", ["get", key]];
    for (const [k, , c, g] of table) {
      color.push(k, c);
      code.push(k, g);
    }
    color.push("#888");
    code.push("");
    m.setPaintProperty("points", "circle-color", color as never);
    m.setLayoutProperty("point-code", "text-field", code as never);
  }

  function fit(m: MlMap, coords: [number, number][]) {
    if (!coords.length) return;
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    m.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 40, maxZoom: 9, duration: 400 });
  }

  function focus(f: MapFeature) {
    setSelected(f.id);
    map.current?.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.current.getZoom(), f.approximate ? 4 : 8) });
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label htmlFor="map-q" className="sr-only">Search the map</label>
          <input id="map-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or city" />
          <button className="rounded-md border border-line px-2 py-1 text-[13px]" onClick={() => map.current && fit(map.current, shown.map((f) => [f.lng, f.lat]))}>Fit to results</button>
          <span className="text-[12px] text-muted">Colour by:</span>
          <button aria-pressed={mode === "progress"} className={`rounded-md border px-2 py-1 text-[13px] ${mode === "progress" ? "border-accent" : "border-line"}`} onClick={() => setMode("progress")}>Outreach progress</button>
          <button aria-pressed={mode === "discovery"} className={`rounded-md border px-2 py-1 text-[13px] ${mode === "discovery" ? "border-accent" : "border-line"}`} onClick={() => setMode("discovery")}>Contact discovery</button>
        </div>
        {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
        <div ref={el} className="h-[560px] w-full rounded-lg border border-line" role="region" aria-label="Map of company locations" />
        <div className="mt-2 flex flex-wrap gap-3 text-[12px]" aria-label="Legend">
          <strong>{mode === "progress" ? "Outreach progress" : "Contact discovery"}:</strong>
          {legend.map(([k, label, color, glyph]) => (
            <span key={k} className="inline-flex items-center gap-1"><span aria-hidden className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: color }}>{glyph}</span>{label}</span>
          ))}
          <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-3 rounded-full bg-[#888] opacity-50" /> faded = approximate (country-level)</span>
        </div>
      </div>
      <div className="max-h-[640px] overflow-y-auto rounded-lg border border-line bg-surface">
        <p className="sticky top-0 border-b border-line bg-surface px-2 py-1 text-[12px] text-muted">{shown.length} mapped companies</p>
        <ul>{shown.slice(0, 600).map((f) => (
          <li key={f.id} className={`border-b border-line px-2 py-1 text-[13px] ${selected === f.id ? "bg-surface-2" : ""}`}>
            <button className="text-left font-medium text-accent" onClick={() => focus(f)}>{f.name}</button>
            <div className="flex justify-between text-[11px] text-muted"><span>{[f.city, f.country].filter(Boolean).join(", ")}{f.approximate ? " · approx." : ""}</span><a href={`/companies/${f.id}`}>Open</a></div>
          </li>
        ))}</ul>
      </div>
    </div>
  );
}
