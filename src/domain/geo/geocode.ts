/**
 * Geocoding of COMPANY locations (never a contact's home address).
 * Order: existing coordinates → cache → configured provider (rate-limited,
 * attribution shown in the map) → offline country centroid marked
 * "approximate (country)". Manual corrections are never overwritten.
 *
 * Providers: GEOCODER=nominatim (GEOCODER_URL, defaults to the public OSM
 * Nominatim, which requires ≤1 request/second, a descriptive User-Agent and
 * attribution; bulk use should point at your own instance or a commercial
 * provider) or GEOCODER=none (offline centroids only).
 */
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@/db/schema";
import { lookupCountry } from "../normalize";
import type { Services } from "../services";
import { errorSummary } from "@/lib/redact";

export interface GeoResult {
  lat: number;
  lng: number;
  precision: "address" | "city" | "country";
  provider: string;
}

export function geocoderConfig() {
  return {
    provider: process.env.GEOCODER ?? "none",
    url: process.env.GEOCODER_URL ?? "https://nominatim.openstreetmap.org/search",
    userAgent: process.env.GEOCODER_USER_AGENT ?? "InternshipOutreachManager/0.1 (self-hosted)",
    minIntervalMs: Number(process.env.GEOCODER_MIN_INTERVAL_MS ?? 1100),
  };
}

let lastCall = 0;

async function providerLookup(query: string, countryCode: string | null): Promise<GeoResult | null> {
  const cfg = geocoderConfig();
  if (cfg.provider !== "nominatim") return null;
  const wait = lastCall + cfg.minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const u = new URL(cfg.url);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "1");
  u.searchParams.set("addressdetails", "0");
  if (countryCode) u.searchParams.set("countrycodes", countryCode.toLowerCase());
  const res = await fetch(u, { headers: { "User-Agent": cfg.userAgent, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (res.status === 429) throw new Error("Geocoder rate limited");
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  const arr = (await res.json()) as { lat: string; lon: string; addresstype?: string; type?: string }[];
  if (!arr[0]) return null;
  const t = arr[0].addresstype ?? arr[0].type ?? "";
  return { lat: Number(arr[0].lat), lng: Number(arr[0].lon), precision: /house|building|road|amenity/.test(t) ? "address" : t === "country" ? "country" : "city", provider: "nominatim" };
}

export async function geocodePending(svc: Services, limit = 25) {
  const db = svc.db;
  const rows = await db.select().from(s.companyLocations).where(eq(s.companyLocations.geocodeStatus, "pending")).limit(limit);
  let resolved = 0;
  for (const loc of rows) {
    const country = lookupCountry(loc.country);
    const query = [loc.city ?? loc.label, country?.name ?? loc.country].filter(Boolean).join(", ");
    const key = `${geocoderConfig().provider}:${query.toLowerCase()}`;
    let result: GeoResult | null = null;
    try {
      const [cached] = await db.select().from(s.geocodeCache).where(eq(s.geocodeCache.queryKey, key));
      if (cached) result = cached.result as GeoResult | null;
      else if (loc.city || loc.label) {
        result = await providerLookup(query, country?.code ?? null);
        if (geocoderConfig().provider !== "none") await db.insert(s.geocodeCache).values({ queryKey: key, provider: geocoderConfig().provider, result: result as object | null }).onConflictDoNothing();
      }
    } catch (e) {
      console.warn("[geocode]", errorSummary(e));
      break; // try again later; list views keep working
    }
    if (!result && country) result = { lat: country.lat, lng: country.lng, precision: "country", provider: "offline-centroid" };
    await db.update(s.companyLocations).set(result
      ? { lat: result.lat, lng: result.lng, precision: result.precision, geocodeStatus: "resolved", geocodeProvider: result.provider, geocodedAt: svc.clock.now() }
      : { geocodeStatus: "unresolved", geocodedAt: svc.clock.now() }).where(and(eq(s.companyLocations.id, loc.id), eq(s.companyLocations.geocodeStatus, "pending")));
    if (result) resolved++;
  }
  return { processed: rows.length, resolved };
}

export async function setManualLocation(svc: Services, ownerId: string, locationId: string, lat: number, lng: number) {
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Invalid coordinates.");
  const [loc] = await svc.db.select({ l: s.companyLocations, c: s.companies }).from(s.companyLocations).innerJoin(s.companies, eq(s.companies.id, s.companyLocations.companyId)).where(eq(s.companyLocations.id, locationId));
  if (!loc || loc.c.ownerId !== ownerId) throw new Error("Not found.");
  await svc.db.update(s.companyLocations).set({ lat, lng, precision: "address", geocodeStatus: "manual", geocodeProvider: "manual", geocodedAt: svc.clock.now() }).where(eq(s.companyLocations.id, locationId));
}

/** Re-queue country-level approximations for a better provider lookup. */
export async function requeueApproximate(svc: Services, ownerId: string) {
  const ids = (await svc.db.select({ id: s.companyLocations.id }).from(s.companyLocations).innerJoin(s.companies, eq(s.companies.id, s.companyLocations.companyId)).where(and(eq(s.companies.ownerId, ownerId), eq(s.companyLocations.geocodeProvider, "offline-centroid")))).map((r) => r.id);
  if (ids.length) await svc.db.update(s.companyLocations).set({ geocodeStatus: "pending" }).where(inArray(s.companyLocations.id, ids));
  return ids.length;
}
