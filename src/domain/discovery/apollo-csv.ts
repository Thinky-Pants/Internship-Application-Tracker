/**
 * Apollo CSV contact import. Column names vary by export; the mapping is
 * suggested from headers and editable (Apollo's export column list could not
 * be confirmed from its help centre, so nothing is hard-coded beyond synonyms).
 *
 * Rules: match companies by domain (strong) or exact name (needs review);
 * dedupe contacts by Apollo ID, then by email; keep the provider's email status
 * verbatim and map it conservatively; the PERSON's city/country go to the
 * contact, never onto the company location. Re-importing is idempotent.
 */
import { and, eq, inArray } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Services } from "../services";
import { extractRecord, type ColumnMapping } from "../import/mapping";
import { cleanKnown, classifyEmailKind, normalizeDomain, normalizeEmail, registrableDomain } from "../normalize";
import { nameKey } from "../import/planner";
import { qualityFromApolloStatus } from "@/providers/apollo/types";

export interface ApolloCsvRowPlan {
  rowNumber: number;
  name: string;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  quality: string;
  companyMatch: { companyId: string; companyName: string; how: "domain" | "name" } | null;
  unresolvedCompany: string | null;
  contactAction: "create" | "update" | "skip";
  existingContactId: string | null;
  personLocation: string | null;
  companyLocationFromCsv: string | null;
  issues: string[];
  raw: Record<string, string | null>;
}

export async function planApolloCsv(svc: Services, ownerId: string, headers: (string | null)[], rows: (string | null)[][], mapping: ColumnMapping): Promise<ApolloCsvRowPlan[]> {
  const db = svc.db;
  const companies = await db.select({ id: s.companies.id, name: s.companies.name, domain: s.companies.domain }).from(s.companies).where(eq(s.companies.ownerId, ownerId));
  const byDomain = new Map<string, typeof companies>();
  const byName = new Map<string, typeof companies>();
  for (const c of companies) {
    const rd = registrableDomain(c.domain);
    if (rd) byDomain.set(rd, [...(byDomain.get(rd) ?? []), c]);
    byName.set(nameKey(c.name), [...(byName.get(nameKey(c.name)) ?? []), c]);
  }
  const apolloIds = new Map((await db.select({ id: s.contacts.id, a: s.contacts.apolloPersonId }).from(s.contacts).where(eq(s.contacts.ownerId, ownerId))).filter((r) => r.a).map((r) => [r.a!, r.id]));
  const emailOwners = new Map((await db.select({ n: s.emailAddresses.normalized, c: s.emailAddresses.contactId }).from(s.emailAddresses).where(eq(s.emailAddresses.ownerId, ownerId))).map((r) => [r.n, r.c]));

  return rows.filter((r) => r.some((c) => c != null)).map((row, i) => {
    const rec = extractRecord(row, mapping);
    const raw = Object.fromEntries(headers.map((h, j) => [h ?? `Column ${j + 1}`, row[j] ?? null]));
    const issues: string[] = [];
    const name = cleanKnown(rec.fullName) ?? [cleanKnown(rec.firstName), cleanKnown(rec.lastName)].filter(Boolean).join(" ");
    const email = normalizeEmail(rec.email);
    if (rec.email && cleanKnown(rec.email) && !email) issues.push(`Invalid email "${rec.email}".`);
    const emailStatus = cleanKnown(rec.emailStatus);
    const dom = registrableDomain(normalizeDomain(rec.companyDomain) ?? (email ? email.split("@")[1] : null));
    let companyMatch: ApolloCsvRowPlan["companyMatch"] = null;
    let unresolved: string | null = null;
    const dCands = dom ? byDomain.get(dom) ?? [] : [];
    if (dCands.length === 1) companyMatch = { companyId: dCands[0].id, companyName: dCands[0].name, how: "domain" };
    else {
      const nCands = byName.get(nameKey(rec.companyName)) ?? [];
      if (dCands.length > 1) issues.push(`Domain ${dom} matches ${dCands.length} companies; choose one.`);
      if (nCands.length === 1 && !dCands.length) {
        companyMatch = { companyId: nCands[0].id, companyName: nCands[0].name, how: "name" };
        issues.push("Matched by company name only — confirm.");
      }
      if (!companyMatch) unresolved = cleanKnown(rec.companyName) ?? dom ?? "(no company)";
    }
    const apolloId = cleanKnown(rec.apolloPersonId);
    const existing = (apolloId && apolloIds.get(apolloId)) || (email && emailOwners.get(email)) || null;
    if (!name) issues.push("Missing person name.");
    return {
      rowNumber: i + 2,
      name: name || "(unnamed)",
      title: cleanKnown(rec.title),
      email,
      emailStatus,
      quality: email ? qualityFromApolloStatus(emailStatus) : "n/a",
      companyMatch,
      unresolvedCompany: unresolved,
      contactAction: !name || !companyMatch ? "skip" : existing ? "update" : "create",
      existingContactId: existing,
      personLocation: [rec.personCity, rec.personState, rec.personCountry].map(cleanKnown).filter(Boolean).join(", ") || null,
      companyLocationFromCsv: [rec.companyCity, rec.companyState, rec.companyCountry].map(cleanKnown).filter(Boolean).join(", ") || null,
      issues,
      raw: { ...raw, __apolloOrgId: cleanKnown(rec.apolloOrgId), __apolloPersonId: apolloId, __linkedin: cleanKnown(rec.linkedinUrl), __seniority: cleanKnown(rec.seniority), __verifiedAt: cleanKnown(rec.emailVerifiedAt) },
    };
  });
}

export async function commitApolloCsv(svc: Services, ownerId: string, batchId: string, plan: ApolloCsvRowPlan[]) {
  const db = svc.db;
  const report = { created: 0, updated: 0, skipped: 0, emailsAdded: 0, unresolvedCompanies: [] as string[] };
  await db.transaction(async (tx) => {
    for (const r of plan) {
      if (r.contactAction === "skip" || !r.companyMatch) {
        report.skipped++;
        if (r.unresolvedCompany) report.unresolvedCompanies.push(r.unresolvedCompany);
        await tx.insert(s.importRows).values({ batchId, sheet: "apollo_csv", rowNumber: r.rowNumber, raw: r.raw, action: "skip", issues: r.issues.length ? r.issues : [`Unresolved company: ${r.unresolvedCompany}`] });
        continue;
      }
      const vals = {
        fullName: r.name, title: r.title, seniority: r.raw.__seniority, linkedinUrl: r.raw.__linkedin, apolloPersonId: r.raw.__apolloPersonId, apolloOrgId: r.raw.__apolloOrgId,
        personLocation: r.personLocation, source: "apollo_csv", reviewStatus: "reviewed",
      };
      let contactId = r.existingContactId;
      if (contactId) {
        // Only fill empty fields; never overwrite manual edits.
        const [cur] = await tx.select().from(s.contacts).where(eq(s.contacts.id, contactId));
        const set: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(vals)) if (v != null && (cur as Record<string, unknown>)[k] == null) set[k] = v;
        if (Object.keys(set).length) await tx.update(s.contacts).set({ ...set, updatedAt: svc.clock.now() }).where(eq(s.contacts.id, contactId));
        report.updated++;
      } else {
        const [c] = await tx.insert(s.contacts).values({ ownerId, companyId: r.companyMatch.companyId, ...vals, source: "apollo_csv" } as typeof s.contacts.$inferInsert).onConflictDoNothing().returning();
        if (c) {
          contactId = c.id;
          report.created++;
        } else {
          const [ex] = await tx.select().from(s.contacts).where(and(eq(s.contacts.ownerId, ownerId), eq(s.contacts.apolloPersonId, r.raw.__apolloPersonId!)));
          contactId = ex?.id ?? null;
          report.updated++;
        }
      }
      if (r.email && contactId) {
        const verifiedAt = r.raw.__verifiedAt ? new Date(r.raw.__verifiedAt) : null;
        const ins = await tx.insert(s.emailAddresses).values({
          ownerId, companyId: r.companyMatch.companyId, contactId, address: r.email, normalized: r.email, kind: classifyEmailKind(r.email), source: "apollo_csv",
          sourceDetail: `Apollo CSV import ${batchId}`, quality: r.quality, providerStatus: r.emailStatus, sourceVerifiedAt: verifiedAt && !Number.isNaN(verifiedAt.getTime()) ? verifiedAt : null,
        }).onConflictDoNothing().returning();
        if (ins.length) report.emailsAdded++;
      }
      // Company location: only as a suggestion when the company has none (never overwritten by contact data).
      if (r.companyLocationFromCsv) {
        const locs = await tx.select().from(s.companyLocations).where(eq(s.companyLocations.companyId, r.companyMatch.companyId));
        if (!locs.length) await tx.insert(s.companyLocations).values({ companyId: r.companyMatch.companyId, kind: "office", label: r.companyLocationFromCsv, geocodeStatus: "pending", precision: "city", isPrimary: true });
      }
      await tx.insert(s.importRows).values({ batchId, sheet: "apollo_csv", rowNumber: r.rowNumber, raw: r.raw, action: r.contactAction, entityType: "contact", entityId: contactId, issues: r.issues });
    }
    const companyIds = [...new Set(plan.filter((p) => p.companyMatch && p.contactAction !== "skip").map((p) => p.companyMatch!.companyId))];
    if (companyIds.length) await tx.update(s.companies).set({ discoveryStatus: "reviewed", discoveryUpdatedAt: svc.clock.now() }).where(inArray(s.companies.id, companyIds));
    await tx.update(s.importBatches).set({ status: "committed", committedAt: svc.clock.now(), report }).where(eq(s.importBatches.id, batchId));
  });
  return report;
}
