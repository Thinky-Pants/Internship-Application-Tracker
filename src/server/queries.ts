import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { companySummaries, type CompanySummary, type OutreachProgress } from "@/domain/summary";

export interface CompanyFilter {
  q?: string;
  priority?: string;
  industry?: string;
  region?: string;
  country?: string;
  email?: "missing" | "available" | "usable" | "verified";
  progress?: OutreachProgress;
  discovery?: string;
  stage?: string;
  role?: string;
  activity?: string; // "7" | "30" | "stale30" | "never"
  followup?: "due" | "overdue";
  demo?: "only" | "hide";
}

export const FILTER_KEYS: (keyof CompanyFilter)[] = ["q", "priority", "industry", "region", "country", "email", "progress", "discovery", "stage", "role", "activity", "followup", "demo"];

export function parseFilter(sp: Record<string, string | string[] | undefined>): CompanyFilter {
  const f: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    const v = sp[k];
    if (typeof v === "string" && v.trim()) f[k] = v.trim();
  }
  return f as CompanyFilter;
}

export function filterQuery(f: CompanyFilter, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, String(v));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export function describeFilter(f: CompanyFilter): string {
  const parts: string[] = [];
  if (f.priority) parts.push(`${f.priority} priority`);
  if (f.industry) parts.push(f.industry);
  if (f.region) parts.push(f.region);
  if (f.country) parts.push(f.country);
  if (f.email) parts.push({ missing: "no email", available: "any address", usable: "usable address", verified: "provider-verified address" }[f.email]);
  if (f.progress) parts.push(f.progress.replace(/_/g, " "));
  if (f.discovery) parts.push(`discovery: ${f.discovery.replace(/_/g, " ")}`);
  if (f.stage) parts.push(`stage: ${f.stage}`);
  if (f.role) parts.push(`role ~ "${f.role}"`);
  if (f.followup) parts.push(`follow-up ${f.followup}`);
  if (f.q) parts.push(`"${f.q}"`);
  return parts.join(" · ") || "All companies";
}

export interface CompanyRow {
  company: typeof s.companies.$inferSelect;
  summary: CompanySummary;
  location: typeof s.companyLocations.$inferSelect | null;
}

export async function listCompanies(ownerId: string, f: CompanyFilter, now = new Date()): Promise<CompanyRow[]> {
  const db = getDb();
  const comps = await db.select().from(s.companies).where(eq(s.companies.ownerId, ownerId));
  const sums = await companySummaries(db, ownerId);
  const ids = comps.map((c) => c.id);
  const locs = ids.length ? await db.select().from(s.companyLocations).where(and(inArray(s.companyLocations.companyId, ids), eq(s.companyLocations.isPrimary, true))) : [];
  const locBy = new Map(locs.map((l) => [l.companyId, l]));
  let roleSet: Set<string> | null = null;
  if (f.role) {
    const rows = await db.select({ c: s.contacts.companyId, t: s.contacts.title }).from(s.contacts).where(eq(s.contacts.ownerId, ownerId));
    roleSet = new Set(rows.filter((r) => (r.t ?? "").toLowerCase().includes(f.role!.toLowerCase())).map((r) => r.c));
  }
  let stageSet: Set<string> | null = null;
  if (f.stage) {
    const rows = await db.select({ c: s.opportunities.companyId }).from(s.opportunities).where(and(eq(s.opportunities.ownerId, ownerId), eq(s.opportunities.stage, f.stage)));
    stageSet = new Set(rows.map((r) => r.c));
  }
  const q = f.q?.toLowerCase();
  const out: CompanyRow[] = [];
  for (const c of comps) {
    const sm = sums.get(c.id)!;
    if (f.demo === "only" && !c.isDemo) continue;
    if (f.demo === "hide" && c.isDemo) continue;
    if (q && !(c.name.toLowerCase().includes(q) || (c.domain ?? "").includes(q) || (c.originalName ?? "").toLowerCase().includes(q))) continue;
    if (f.priority && c.priority !== f.priority) continue;
    if (f.industry && c.industryPrimary !== f.industry && c.industrySecondary !== f.industry) continue;
    if (f.region && c.regionGroup !== f.region) continue;
    if (f.country && c.country !== f.country) continue;
    if (f.email === "missing" && sm.emailAvailability !== "missing") continue;
    if (f.email === "available" && sm.emailAvailability !== "available") continue;
    if (f.email === "usable" && !sm.usableAddress) continue;
    if (f.email === "verified" && sm.bestQuality !== "provider_verified") continue;
    if (f.progress && sm.outreach !== f.progress) continue;
    if (f.discovery && c.discoveryStatus !== f.discovery) continue;
    if (roleSet && !roleSet.has(c.id)) continue;
    if (stageSet && !stageSet.has(c.id)) continue;
    if (f.activity) {
      const days = sm.lastActivityAt ? (now.getTime() - sm.lastActivityAt.getTime()) / 86400_000 : Infinity;
      if (f.activity === "never" && sm.lastActivityAt) continue;
      if (f.activity === "stale30" && days < 30) continue;
      if (/^\d+$/.test(f.activity) && days > Number(f.activity)) continue;
    }
    if (f.followup === "due" && !(sm.nextFollowupAt && sm.nextFollowupAt.getTime() - now.getTime() < 7 * 86400_000)) continue;
    if (f.followup === "overdue" && !(sm.nextFollowupAt && sm.nextFollowupAt < now)) continue;
    out.push({ company: c, summary: sm, location: locBy.get(c.id) ?? null });
  }
  const rank: Record<string, number> = { primary: 4, reserve: 3, lead: 2, other: 1 };
  return out.sort((a, b) => (rank[b.company.priority] ?? 0) - (rank[a.company.priority] ?? 0) || (b.company.fitScore ?? -1) - (a.company.fitScore ?? -1) || a.company.name.localeCompare(b.company.name));
}

export async function filterOptions(ownerId: string) {
  const db = getDb();
  const comps = await db.select({ industry: s.companies.industryPrimary, region: s.companies.regionGroup, country: s.companies.country }).from(s.companies).where(eq(s.companies.ownerId, ownerId));
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter(Boolean) as string[])].sort();
  return { industries: uniq(comps.map((c) => c.industry)), regions: uniq(comps.map((c) => c.region)), countries: uniq(comps.map((c) => c.country)) };
}
