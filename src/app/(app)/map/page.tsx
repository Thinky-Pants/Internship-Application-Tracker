import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { listCompanies, parseFilter, filterOptions, filterQuery, type CompanyFilter } from "@/server/queries";
import { FilterBar } from "@/components/filter-bar";
import { MapView, type MapFeature } from "@/components/map-view";
import { PageHeader, Section, LinkButton } from "@/components/ui";
import { Flash } from "@/components/flash";
import { mapStyle } from "@/server/map-config";

export const metadata = { title: "World Map" };

export default async function MapPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const f = parseFilter(sp);
  const db = getDb();
  const [rows, options, views, [st]] = await Promise.all([
    listCompanies(owner.id, f),
    filterOptions(owner.id),
    db.select().from(s.savedViews).where(and(eq(s.savedViews.ownerId, owner.id), eq(s.savedViews.view, "/map"))),
    db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id)),
  ]);
  const features: MapFeature[] = [];
  const unresolved: typeof rows = [];
  for (const r of rows) {
    if (r.location?.lat != null && r.location.lng != null) features.push({ id: r.company.id, name: r.company.name, lat: r.location.lat, lng: r.location.lng, progress: r.summary.outreach, discovery: r.company.discoveryStatus, approximate: r.location.precision === "country", country: r.company.country, city: r.company.city, priority: r.company.priority });
    else unresolved.push(r);
  }
  const { styleUrl, attribution } = mapStyle(st);
  return (
    <>
      <PageHeader title="World Map" subtitle={`${features.length} of ${rows.length} matching companies have map coordinates. Pins show company offices, never a contact's home location.`} actions={<LinkButton href={`/companies${filterQuery(f)}`}>Open as table</LinkButton>} />
      <Flash sp={sp} />
      <FilterBar f={f} options={options} action="/map" views={views.map((v) => ({ id: v.id, name: v.name, qs: filterQuery(v.filters as CompanyFilter) }))} />
      <MapView features={features} styleUrl={styleUrl} attribution={attribution} />
      <Section title={`Unresolved locations (${unresolved.length})`} className="mt-3">
        <p className="mb-2 text-[12px] text-muted">Geocoding runs in the worker (existing coordinates first, then the configured geocoder with caching and rate limits, then an approximate country centroid). Correct any location from its company page.</p>
        <ul className="columns-1 text-[13px] md:columns-3">{unresolved.slice(0, 300).map((r) => <li key={r.company.id}><Link href={`/companies/${r.company.id}`}>{r.company.name}</Link> <span className="text-[11px] text-muted">{[r.company.city, r.company.country].filter(Boolean).join(", ") || "no location"} · {r.location?.geocodeStatus ?? "none"}</span></li>)}</ul>
      </Section>
    </>
  );
}
