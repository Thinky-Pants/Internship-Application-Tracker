/**
 * Contact discovery (Apollo API path). Rules:
 *  - Search hits are candidates only; a company stays "missing email" until an
 *    actual usable address arrives from enrichment, CSV, website or manual entry.
 *  - Operational failures (auth, access, timeout, throttling, budget) are recorded
 *    as such and never downgrade the company to "no suitable match".
 *  - Enrichment is run only for people the owner selected, skips people already
 *    resolved or enriched recently, and is gated by a credit/request budget.
 *  - Phone and personal-email reveal are never requested.
 */
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Services } from "../services";
import { ApolloError, qualityFromApolloStatus, type ApolloPersonCandidate } from "@/providers/apollo/types";
import { classifyEmailKind, normalizeEmail } from "../normalize";
import { errorSummary } from "@/lib/redact";
import { audit } from "../audit";

export const DEFAULT_ROLE_HEURISTICS = {
  smallCompanyMaxEmployees: 50,
  smallCompany: { titles: ["founder", "co-founder", "ceo", "cto", "chief technology officer", "head of engineering"], seniorities: ["founder", "owner", "c_suite"] },
  engineering: { titles: ["head of mechanical engineering", "mechanical engineering manager", "engineering manager", "director of engineering", "vp engineering", "head of hardware", "manufacturing manager", "head of product"], seniorities: ["head", "director", "vp", "manager"] },
  recruiting: { titles: ["recruiter", "talent acquisition", "university recruiting", "talent partner", "hr manager"], seniorities: ["manager", "senior", "director"] },
  note: "Suggestions only — a title does not guarantee hiring authority.",
};

export type RoleHeuristics = typeof DEFAULT_ROLE_HEURISTICS;

export function suggestFilters(h: RoleHeuristics, sizeText: string | null) {
  const n = Number(String(sizeText ?? "").replace(/[^\d]/g, "").slice(0, 6)) || null;
  const small = n != null && n <= h.smallCompanyMaxEmployees;
  const groups = small ? [h.smallCompany, h.engineering] : [h.engineering, h.recruiting];
  return {
    small,
    titles: [...new Set(groups.flatMap((g) => g.titles))],
    seniorities: [...new Set(groups.flatMap((g) => g.seniorities))],
    explanation: small ? `About ${n} employees: founders and engineering leads first, then recruiting.` : "Engineering/manufacturing leaders and recruiting contacts.",
  };
}

const OUTCOME_FOR: Record<ApolloError["kind"], { status: string; outcome: string }> = {
  auth_error: { status: "blocked_access", outcome: "auth_error" },
  access_denied: { status: "blocked_access", outcome: "access_denied" },
  rate_limited: { status: "pending", outcome: "rate_limited" },
  timeout: { status: "failed", outcome: "timeout" },
  insufficient_info: { status: "completed", outcome: "insufficient_info" },
  error: { status: "failed", outcome: "error" },
};

export async function searchCompany(svc: Services, args: { ownerId: string; companyId: string; titles?: string[]; seniorities?: string[]; jobId?: string; attemptId?: string }) {
  const db = svc.db;
  const now = svc.clock.now();
  const [co] = await db.select().from(s.companies).where(and(eq(s.companies.id, args.companyId), eq(s.companies.ownerId, args.ownerId)));
  if (!co) throw new Error("Company not found.");
  const apollo = await svc.apollo(args.ownerId);
  const filters = { domain: co.domain, titles: args.titles ?? [], seniorities: args.seniorities ?? [] };
  let attemptId = args.attemptId;
  if (!attemptId) {
    const [a] = await db.insert(s.discoveryAttempts).values({ ownerId: args.ownerId, jobId: args.jobId ?? null, companyId: co.id, provider: apollo?.kind ?? "apollo", kind: "search", filters, status: "running", attemptedAt: now, creditsEstimated: "0" }).returning();
    attemptId = a.id;
  } else await db.update(s.discoveryAttempts).set({ status: "running", attemptedAt: now, attemptCount: sql`${s.discoveryAttempts.attemptCount} + 1` }).where(eq(s.discoveryAttempts.id, attemptId));

  const finish = async (set: Partial<typeof s.discoveryAttempts.$inferInsert>) => {
    await db.update(s.discoveryAttempts).set({ completedAt: svc.clock.now(), ...set }).where(eq(s.discoveryAttempts.id, attemptId!));
    const [a] = await db.select().from(s.discoveryAttempts).where(eq(s.discoveryAttempts.id, attemptId!));
    return a;
  };
  if (!apollo) return finish({ status: "blocked_access", outcome: "auth_error", errorMessage: "Apollo is not configured. Use the CSV import or add contacts manually." });
  if (!co.domain) return finish({ status: "completed", outcome: "insufficient_info", errorMessage: "Company has no domain to search by." });

  await db.update(s.companies).set({ discoveryStatus: co.discoveryStatus === "not_researched" ? "searching" : co.discoveryStatus, discoveryUpdatedAt: now }).where(eq(s.companies.id, co.id));
  try {
    const { candidates } = await apollo.searchPeople({ domain: co.domain, titles: args.titles, seniorities: args.seniorities, perPage: 10 });
    await db.insert(s.usageLedger).values({ ownerId: args.ownerId, provider: apollo.kind, unit: "requests", amount: "1", isEstimate: false, ref: `search:${attemptId}` });
    await db.insert(s.usageLedger).values({ ownerId: args.ownerId, provider: apollo.kind, unit: "credits", amount: "0", isEstimate: true, ref: `search:${attemptId} (People API Search is documented as 0 credits)` });
    const status = candidates.length ? "candidate_found" : "no_suitable_match";
    await db.update(s.companies).set({ discoveryStatus: co.discoveryStatus === "reviewed" && candidates.length ? "reviewed" : status, discoveryUpdatedAt: svc.clock.now() }).where(eq(s.companies.id, co.id));
    return finish({ status: "completed", outcome: candidates.length ? "match_found" : "no_match", candidates, creditsActual: null, creditsEstimated: "0" });
  } catch (e) {
    const ae = e instanceof ApolloError ? e : new ApolloError("error", errorSummary(e));
    const m = OUTCOME_FOR[ae.kind];
    // Revert "searching" without implying "no match".
    await db.update(s.companies).set({ discoveryStatus: co.discoveryStatus, discoveryUpdatedAt: svc.clock.now() }).where(eq(s.companies.id, co.id));
    return finish({ status: m.status, outcome: m.outcome, errorMessage: ae.message, retryAfter: ae.retryAfterSeconds ? new Date(svc.clock.now().getTime() + ae.retryAfterSeconds * 1000) : null });
  }
}

/** Save a selected search candidate as a contact (no email yet). */
export async function addCandidateAsContact(svc: Services, args: { ownerId: string; companyId: string; candidate: ApolloPersonCandidate }) {
  const c = args.candidate;
  const [existing] = await svc.db.select().from(s.contacts).where(and(eq(s.contacts.ownerId, args.ownerId), eq(s.contacts.apolloPersonId, c.apolloPersonId)));
  if (existing) return existing;
  const [row] = await svc.db.insert(s.contacts).values({
    ownerId: args.ownerId, companyId: args.companyId, fullName: c.fullName, firstName: c.firstName, lastName: c.lastName, title: c.title, seniority: c.seniority,
    department: c.departments.join(", ") || null, linkedinUrl: c.linkedinUrl, source: "apollo_api", apolloPersonId: c.apolloPersonId, apolloOrgId: c.organizationId,
    personLocation: c.personLocation, reviewStatus: "reviewed",
  }).returning();
  await svc.db.update(s.companies).set({ discoveryStatus: "reviewed", discoveryUpdatedAt: svc.clock.now() }).where(eq(s.companies.id, args.companyId));
  return row;
}

export interface EnrichPlan {
  toEnrich: { contactId: string; name: string; company: string }[];
  skipped: { contactId: string; name: string; reason: string }[];
  estimatedCredits: number;
  estimateNote: string;
  budgetRemaining: number | null;
}

export async function planEnrichment(svc: Services, ownerId: string, contactIds: string[], opts: { cacheDays?: number; creditBudget?: number | null } = {}): Promise<EnrichPlan> {
  const db = svc.db;
  const cacheSince = new Date(svc.clock.now().getTime() - (opts.cacheDays ?? 30) * 86400_000);
  const rows = await db.select({ c: s.contacts, co: s.companies }).from(s.contacts).innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId)).where(and(eq(s.contacts.ownerId, ownerId), inArray(s.contacts.id, contactIds)));
  const emails = contactIds.length ? await db.select().from(s.emailAddresses).where(and(inArray(s.emailAddresses.contactId, contactIds), eq(s.emailAddresses.suppressed, false))) : [];
  const recent = contactIds.length ? await db.select().from(s.discoveryAttempts).where(and(inArray(s.discoveryAttempts.contactId, contactIds), eq(s.discoveryAttempts.kind, "enrich"), eq(s.discoveryAttempts.status, "completed"), gt(s.discoveryAttempts.completedAt, cacheSince))) : [];
  const plan: EnrichPlan = { toEnrich: [], skipped: [], estimatedCredits: 0, estimateNote: "Estimate: up to 1 credit per person when an email or demographics are returned (Apollo charges only when data is found). Actual usage is recorded per response.", budgetRemaining: opts.creditBudget ?? null };
  for (const { c, co } of rows) {
    if (!c.apolloPersonId) plan.skipped.push({ contactId: c.id, name: c.fullName, reason: "Not an Apollo person (no Apollo ID)." });
    else if (emails.some((e) => e.contactId === c.id && e.quality !== "invalid" && e.bounceState !== "hard")) plan.skipped.push({ contactId: c.id, name: c.fullName, reason: "Already has a usable address." });
    else if (recent.some((r) => r.contactId === c.id)) plan.skipped.push({ contactId: c.id, name: c.fullName, reason: `Enriched within ${opts.cacheDays ?? 30} days (cached result).` });
    else plan.toEnrich.push({ contactId: c.id, name: c.fullName, company: co.name });
  }
  plan.estimatedCredits = plan.toEnrich.length;
  return plan;
}

export async function enrichContacts(svc: Services, args: { ownerId: string; contactIds: string[]; creditBudget?: number | null; jobId?: string }) {
  const db = svc.db;
  const plan = await planEnrichment(svc, args.ownerId, args.contactIds, { creditBudget: args.creditBudget });
  const apollo = await svc.apollo(args.ownerId);
  let used = 0;
  const results: { contactId: string; outcome: string; email?: string | null }[] = [];
  for (const item of plan.toEnrich) {
    const [c] = await db.select().from(s.contacts).where(eq(s.contacts.id, item.contactId));
    const [co] = await db.select().from(s.companies).where(eq(s.companies.id, c.companyId));
    const base = { ownerId: args.ownerId, jobId: args.jobId ?? null, companyId: c.companyId, contactId: c.id, provider: apollo?.kind ?? "apollo", kind: "enrich", filters: { apolloPersonId: c.apolloPersonId }, attemptedAt: svc.clock.now() };
    if (!apollo) {
      await db.insert(s.discoveryAttempts).values({ ...base, status: "blocked_access", outcome: "auth_error", errorMessage: "Apollo not configured." });
      results.push({ contactId: c.id, outcome: "auth_error" });
      continue;
    }
    if (args.creditBudget != null && used + 1 > args.creditBudget) {
      await db.insert(s.discoveryAttempts).values({ ...base, status: "blocked_budget", outcome: "budget_exhausted", errorMessage: `Credit budget ${args.creditBudget} reached.` });
      results.push({ contactId: c.id, outcome: "budget_exhausted" });
      continue;
    }
    try {
      const r = await apollo.enrichPerson({ apolloPersonId: c.apolloPersonId!, domain: co.domain });
      const credits = r.creditsConsumed;
      used += credits ?? 1;
      await db.insert(s.usageLedger).values({ ownerId: args.ownerId, provider: apollo.kind, unit: "credits", amount: String(credits ?? 1), isEstimate: credits == null, ref: `enrich:${c.id}` });
      const addr = normalizeEmail(r.email);
      if (addr) {
        const quality = qualityFromApolloStatus(r.emailStatus);
        await db.insert(s.emailAddresses).values({
          ownerId: args.ownerId, companyId: c.companyId, contactId: c.id, address: addr, normalized: addr, kind: classifyEmailKind(addr), source: "apollo_api",
          sourceDetail: `Apollo enrichment (match confidence: ${r.matchConfidence ?? "n/a"})`, quality, providerStatus: r.emailStatus, sourceVerifiedAt: quality === "provider_verified" ? svc.clock.now() : null,
        }).onConflictDoUpdate({ target: [s.emailAddresses.ownerId, s.emailAddresses.normalized], set: { providerStatus: r.emailStatus, quality: sql`CASE WHEN ${s.emailAddresses.bounceState} = 'hard' THEN 'invalid' ELSE ${quality} END` } });
      }
      await db.insert(s.discoveryAttempts).values({ ...base, status: "completed", outcome: addr ? "email_revealed" : "email_not_revealed", candidates: [{ email: addr, emailStatus: r.emailStatus }], creditsActual: credits != null ? String(credits) : null, creditsEstimated: credits == null ? "1" : null, completedAt: svc.clock.now() });
      results.push({ contactId: c.id, outcome: addr ? "email_revealed" : "email_not_revealed", email: addr });
    } catch (e) {
      const ae = e instanceof ApolloError ? e : new ApolloError("error", errorSummary(e));
      const m = OUTCOME_FOR[ae.kind];
      await db.insert(s.discoveryAttempts).values({ ...base, status: m.status, outcome: m.outcome, errorMessage: ae.message, retryAfter: ae.retryAfterSeconds ? new Date(svc.clock.now().getTime() + ae.retryAfterSeconds * 1000) : null });
      results.push({ contactId: c.id, outcome: m.outcome });
      if (ae.kind === "rate_limited" || ae.kind === "auth_error" || ae.kind === "access_denied") break; // stop the run; remaining stay unstarted
    }
  }
  return { plan, results, creditsUsed: used };
}

// ───────────────────────── Batch search jobs ─────────────────────────
export async function createDiscoveryJob(svc: Services, args: { ownerId: string; companyIds: string[]; titles?: string[]; seniorities?: string[]; maxPerCompany?: number; requestBudget?: number | null }) {
  const db = svc.db;
  const cos = await db.select().from(s.companies).where(and(eq(s.companies.ownerId, args.ownerId), inArray(s.companies.id, args.companyIds)));
  const rank: Record<string, number> = { primary: 4, reserve: 3, lead: 2, other: 1 };
  const ordered = cos.sort((a, b) => (rank[b.priority] ?? 0) - (rank[a.priority] ?? 0) || (b.fitScore ?? 0) - (a.fitScore ?? 0));
  const [job] = await db.insert(s.discoveryJobs).values({ ownerId: args.ownerId, provider: "apollo", kind: "search", status: "pending", filters: { titles: args.titles ?? [], seniorities: args.seniorities ?? [] }, maxPerCompany: args.maxPerCompany ?? 5, requestBudget: args.requestBudget ?? null, totalItems: ordered.length }).returning();
  if (ordered.length) await db.insert(s.discoveryAttempts).values(ordered.map((c, i) => ({ ownerId: args.ownerId, jobId: job.id, companyId: c.id, provider: "apollo", kind: "search", filters: job.filters as object, priority: ordered.length - i, status: "pending" })));
  return job;
}

export async function discoveryJobSummary(svc: Services, ownerId: string, companyIds: string[]) {
  const db = svc.db;
  const cos = companyIds.length ? await db.select().from(s.companies).where(and(eq(s.companies.ownerId, ownerId), inArray(s.companies.id, companyIds))) : [];
  const withEmail = companyIds.length ? await db.selectDistinct({ id: s.emailAddresses.companyId }).from(s.emailAddresses).where(inArray(s.emailAddresses.companyId, companyIds)) : [];
  return {
    companies: cos.length,
    withoutDomain: cos.filter((c) => !c.domain).length,
    alreadyHaveAddress: withEmail.length,
    searchRequests: cos.filter((c) => c.domain).length,
    searchCredits: 0,
    note: "People search is documented as 0 credits but counts toward Apollo rate limits. Enrichment is a separate, explicit step for selected people.",
  };
}

/** Worker step: process the next pending attempt of running jobs (respects pause/cancel/limits). */
export async function runDiscoveryStep(svc: Services, limit = 5) {
  const db = svc.db;
  const now = svc.clock.now();
  const jobs = await db.select().from(s.discoveryJobs).where(inArray(s.discoveryJobs.status, ["pending", "running"]));
  let processed = 0;
  for (const job of jobs) {
    if (job.status === "pending") await db.update(s.discoveryJobs).set({ status: "running" }).where(eq(s.discoveryJobs.id, job.id));
    const pend = await db.select().from(s.discoveryAttempts).where(and(eq(s.discoveryAttempts.jobId, job.id), eq(s.discoveryAttempts.status, "pending"))).orderBy(desc(s.discoveryAttempts.priority)).limit(limit);
    if (!pend.length) {
      await db.update(s.discoveryJobs).set({ status: "completed", updatedAt: now }).where(eq(s.discoveryJobs.id, job.id));
      continue;
    }
    for (const a of pend) {
      if (a.retryAfter && a.retryAfter > now) return processed; // respect rate limit
      if (job.requestBudget != null && job.requestsUsed >= job.requestBudget) {
        await db.update(s.discoveryAttempts).set({ status: "blocked_budget", outcome: "budget_exhausted", errorMessage: "Request budget for this job reached." }).where(and(eq(s.discoveryAttempts.jobId, job.id), eq(s.discoveryAttempts.status, "pending")));
        break;
      }
      // Claim (CAS) so two workers don't run the same attempt.
      const [claimed] = await db.update(s.discoveryAttempts).set({ status: "running" }).where(and(eq(s.discoveryAttempts.id, a.id), eq(s.discoveryAttempts.status, "pending"))).returning();
      if (!claimed) continue;
      const f = job.filters as { titles?: string[]; seniorities?: string[] };
      const r = await searchCompany(svc, { ownerId: job.ownerId, companyId: a.companyId, titles: f.titles, seniorities: f.seniorities, jobId: job.id, attemptId: a.id });
      processed++;
      await db.update(s.discoveryJobs).set({ requestsUsed: sql`${s.discoveryJobs.requestsUsed} + 1`, doneItems: sql`${s.discoveryJobs.doneItems} + ${r.status === "pending" ? 0 : 1}`, updatedAt: svc.clock.now() }).where(eq(s.discoveryJobs.id, job.id));
      if (r.outcome === "rate_limited") return processed;
      if (r.outcome === "auth_error" || r.outcome === "access_denied") {
        await db.update(s.discoveryJobs).set({ status: "paused", updatedAt: svc.clock.now() }).where(eq(s.discoveryJobs.id, job.id));
        break;
      }
    }
  }
  return processed;
}

export async function setDiscoveryJobState(svc: Services, ownerId: string, jobId: string, action: "pause" | "resume" | "cancel") {
  const db = svc.db;
  if (action === "cancel") {
    // Only unstarted work is cancelled; completed attempts remain on record.
    await db.update(s.discoveryAttempts).set({ status: "cancelled" }).where(and(eq(s.discoveryAttempts.jobId, jobId), eq(s.discoveryAttempts.status, "pending")));
    await db.update(s.discoveryJobs).set({ status: "cancelled" }).where(and(eq(s.discoveryJobs.id, jobId), eq(s.discoveryJobs.ownerId, ownerId)));
  } else await db.update(s.discoveryJobs).set({ status: action === "pause" ? "paused" : "running" }).where(and(eq(s.discoveryJobs.id, jobId), eq(s.discoveryJobs.ownerId, ownerId)));
  if (action === "resume") await db.update(s.discoveryAttempts).set({ status: "pending" }).where(and(eq(s.discoveryAttempts.jobId, jobId), inArray(s.discoveryAttempts.status, ["failed"])));
}

/** Manually add an address (website-sourced or typed); never "verified" by default. */
export async function addManualEmail(svc: Services, args: { ownerId: string; companyId: string; contactId?: string | null; address: string; source: "website" | "manual" | "ai_guess"; sourceUrl?: string | null }) {
  const addr = normalizeEmail(args.address);
  if (!addr) throw new Error("That is not a valid email address.");
  const [row] = await svc.db.insert(s.emailAddresses).values({ ownerId: args.ownerId, companyId: args.companyId, contactId: args.contactId ?? null, address: addr, normalized: addr, kind: classifyEmailKind(addr), source: args.source, sourceDetail: args.sourceUrl ?? null, quality: "unknown", localCheckedAt: svc.clock.now() }).onConflictDoNothing().returning();
  if (!row) throw new Error("That address is already recorded.");
  await audit(svc.db, { ownerId: args.ownerId, entityType: "email", entityId: row.id, action: "add", after: { address: addr, source: args.source } });
  return row;
}

export async function companyDiscoveryHistory(svc: Services, companyId: string) {
  return svc.db.select().from(s.discoveryAttempts).where(and(eq(s.discoveryAttempts.companyId, companyId), isNotNull(s.discoveryAttempts.attemptedAt))).orderBy(desc(s.discoveryAttempts.attemptedAt));
}
