/** Map tiles are a configurable service with required attribution (separate from geocoding). */
export function mapStyle(st: { mapConfig: unknown }) {
  const cfg = (st.mapConfig ?? {}) as { styleUrl?: string; attribution?: string };
  return {
    styleUrl: cfg.styleUrl || process.env.MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty",
    attribution: cfg.attribution || process.env.MAP_ATTRIBUTION || "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors",
  };
}
