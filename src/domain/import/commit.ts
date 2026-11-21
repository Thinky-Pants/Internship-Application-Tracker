/**
 * Import persistence: snapshot existing companies, commit a plan inside one
 * transaction, and roll back an import safely.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import crypto from "node:crypto";
import type { Db, DbOrTx } from "@/db/client";
import * as s from "@/db/schema";
import { classifyEmailKind, lookupCountry, suggestTimezone } from "../normalize";
import type { ExistingCompany, ImportPlan, PlanRow, ScalarField } from "./planner";
import { SCALAR_FIELDS } from "./planner";
import { audit } from "../audit";

const COLUMN_OF: Record<ScalarField, keyof typeof s.companies.$inferInsert> = {
  name: "name", originalName: "originalName", website: "website", domain: "domain", description: "description", sizeText: "sizeText",
  fitScore: "fitScore", matchTier: "matchTier", industryPrimary: "industryPrimary", industrySecondary: "industrySecondary",
  regionGroup: "regionGroup", country: "country", countryCode: "countryCode", city: "city", engineeringLocation: "engineeringLocation",
  engineeringActivity: "engineeringActivity", potentialInternWork: "potentialInternWork", internshipEvidence: "internshipEvidence",
  careersUrl: "careersUrl", opportunityUrl: "opportunityUrl", eligibilityStatus: "eligibilityStatus", eligibilityNotes: "eligibilityNotes",
  foundedText: "foundedText", notes: "notes", researchNotes: "researchNotes", importedOutreachStatus: "importedOutreachStatus", priority: "priority",
};

export async function loadExistingSnapshot(db: DbOrTx, ownerId: string): Promise<ExistingCompany[]> {
  const rows = await db.select().from(s.companies).where(eq(s.companies.ownerId, ownerId));
  const ext = await db.select().from(s.companyExternalIds).where(eq(s.companyExternalIds.ownerId, ownerId));
  const extBy = new Map<string, string[]>();
  for (const e of ext) extBy.set(e.companyId, [...(extBy.get(e.companyId) ?? []), e.value]);
  return rows.map((r) => {
    const fields: ExistingCompany["fields"] = {};
    for (const f of SCALAR_FIELDS) {
      const v = r[COLUMN_OF[f]] as string | number | null | undefined;
      if (v != null) fields[f] = v as string | number;
    }
    return {
      id: r.id,
      name: r.name,
      domain: r.domain,
      externalIds: [...new Set([...(extBy.get(r.id) ?? []), ...(r.externalId ? [r.externalId] : [])])],
      fields,
      provenance: (r.fieldProvenance ?? {}) as ExistingCompany["provenance"],
    };
  });
}

/** resolutions: `${rowKey}:${field}` → "incoming" applies the incoming value for a conflict; default keeps existing. */
export type ConflictResolutions = Record<string, "keep" | "incoming">;

export interface CommitReport {
  added: number;
  updated: number;
  unchanged: number;
  merged: number;
  duplicatesForReview: number;
  invalid: number;
  evidenceUpserted: number;
  evidenceUnmatched: number;
  conflictsKept: number;
  conflictsTakenIncoming: number;
  emailsAdded: number;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function commitImport(
  db: Db,
  args: { ownerId: string; batchId: string; plan: ImportPlan; resolutions?: ConflictResolutions; isDemo?: boolean; now?: Date },
): Promise<CommitReport> {
  const { ownerId, batchId, plan } = args;
  const resolutions = args.resolutions ?? {};
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const report: CommitReport = { added: 0, updated: 0, unchanged: 0, merged: 0, duplicatesForReview: 0, invalid: 0, evidenceUpserted: 0, evidenceUnmatched: 0, conflictsKept: 0, conflictsTakenIncoming: 0, emailsAdded: 0 };

  await db.transaction(async (tx) => {
    const idByKey = new Map<string, string>();
    const importRows: (typeof s.importRows.$inferInsert)[] = [];
    const extIdRows: (typeof s.companyExternalIds.$inferInsert)[] = [];
    const tagRows: (typeof s.companyTags.$inferInsert)[] = [];
    const locRows: (typeof s.companyLocations.$inferInsert)[] = [];
    const companyInserts: (typeof s.companies.$inferInsert)[] = [];
    const emails: { companyId: string; email: NonNullable<PlanRow["incoming"]>["email"] }[] = [];

    const provFor = (row: PlanRow, fields: string[]) => {
      const p: Record<string, unknown> = {};
      for (const f of fields) p[f] = { source: "import", at: nowIso, batchId, asOf: row.incoming?.asOf ?? null, sheet: row.sheet };
      return p;
    };

    // ── Adds (bulk) ──
    for (const row of plan.rows.filter((r) => r.action === "add")) {
      const inc = row.incoming!;
      const id = crypto.randomUUID();
      idByKey.set(row.key, id);
      const values: Record<string, unknown> = {};
      for (const f of SCALAR_FIELDS) if (inc.fields[f] != null) values[COLUMN_OF[f]] = inc.fields[f];
      companyInserts.push({
        ...(values as object),
        id,
        ownerId,
        name: inc.fields.name as string,
        externalId: inc.externalId,
        sourceSheet: row.sheet,
        sourceRow: { [row.sheet]: inc.sourceRow },
        fieldProvenance: provFor(row, Object.keys(inc.fields)),
        importBatchId: batchId,
        isDemo: args.isDemo ?? false,
        createdAt: now,
        updatedAt: now,
      } as typeof s.companies.$inferInsert);
      if (inc.externalId) extIdRows.push({ ownerId, companyId: id, value: inc.externalId, sourceSheet: row.sheet });
      for (const t of inc.tags) tagRows.push({ companyId: id, tag: t, kind: "industry" });
      locRows.push(locationFor(id, inc));
      if (inc.email) emails.push({ companyId: id, email: inc.email });
      importRows.push({ batchId, sheet: row.sheet, rowNumber: row.rowNumber, raw: row.raw, action: "add", entityType: "company", entityId: id, appliedFields: {}, issues: row.issues });
      report.added++;
    }
    for (const c of chunk(companyInserts, 200)) await tx.insert(s.companies).values(c);

    // ── Updates / merges / others (row by row; usually fewer) ──
    for (const row of plan.rows) {
      if (row.action === "update" || row.action === "unchanged") {
        const id = row.targetCompanyId!;
        idByKey.set(row.key, id);
        const inc = row.incoming!;
        const set: Record<string, unknown> = {};
        const applied: Record<string, { before: unknown; after: unknown }> = {};
        const provFields: string[] = [];
        for (const ch of row.changes) {
          set[COLUMN_OF[ch.field as ScalarField]] = ch.to;
          applied[ch.field] = { before: ch.from, after: ch.to };
          provFields.push(ch.field);
        }
        for (const cf of row.conflicts) {
          if (resolutions[`${row.key}:${cf.field}`] === "incoming") {
            set[COLUMN_OF[cf.field as ScalarField]] = cf.incoming;
            applied[cf.field] = { before: cf.existing, after: cf.incoming };
            provFields.push(cf.field);
            report.conflictsTakenIncoming++;
          } else report.conflictsKept++;
        }
        if (Object.keys(set).length) {
          const [cur] = await tx.select({ prov: s.companies.fieldProvenance, srcRow: s.companies.sourceRow }).from(s.companies).where(eq(s.companies.id, id));
          await tx.update(s.companies).set({
            ...set,
            fieldProvenance: { ...(cur?.prov as object), ...provFor(row, provFields) },
            sourceRow: { ...((cur?.srcRow as object) ?? {}), [row.sheet]: inc.sourceRow },
            revision: sql`${s.companies.revision} + 1`,
            updatedAt: now,
          }).where(eq(s.companies.id, id));
          if ("country" in applied || "city" in applied) await refreshLocation(tx, id, inc);
          await audit(tx, { ownerId, entityType: "company", entityId: id, action: "import_update", before: Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, v.before])), after: Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, v.after])), actor: `import:${batchId}` });
        }
        if (inc.externalId) extIdRows.push({ ownerId, companyId: id, value: inc.externalId, sourceSheet: row.sheet });
        for (const t of inc.tags) tagRows.push({ companyId: id, tag: t, kind: "industry" });
        if (inc.email) emails.push({ companyId: id, email: inc.email });
        importRows.push({ batchId, sheet: row.sheet, rowNumber: row.rowNumber, raw: row.raw, action: Object.keys(set).length ? "update" : "unchanged", entityType: "company", entityId: id, appliedFields: applied, issues: [...row.issues, ...row.conflicts.map((c) => `Conflict on ${c.field}: ${resolutions[`${row.key}:${c.field}`] === "incoming" ? "took incoming" : "kept existing"} (${c.reason}).`)] });
        if (Object.keys(set).length) report.updated++;
        else report.unchanged++;
      } else if (row.action === "merge_in_batch") {
        const id = row.targetCompanyId ?? idByKey.get(row.mergeIntoKey!);
        if (!id) throw new Error(`Merge target for ${row.key} not found.`);
        idByKey.set(row.key, id);
        const inc = row.incoming!;
        // Fill empty fields only.
        const [cur] = await tx.select().from(s.companies).where(eq(s.companies.id, id));
        const set: Record<string, unknown> = {};
        const applied: Record<string, { before: unknown; after: unknown }> = {};
        for (const f of SCALAR_FIELDS) {
          if (f === "priority" || inc.fields[f] == null) continue;
          if (cur[COLUMN_OF[f]] == null) {
            set[COLUMN_OF[f]] = inc.fields[f];
            applied[f] = { before: null, after: inc.fields[f] };
          }
        }
        await tx.update(s.companies).set({
          ...set,
          fieldProvenance: { ...(cur.fieldProvenance as object), ...provFor(row, Object.keys(applied)) },
          sourceRow: { ...((cur.sourceRow as object) ?? {}), [row.sheet]: inc.sourceRow },
          updatedAt: now,
        }).where(eq(s.companies.id, id));
        if (inc.externalId) extIdRows.push({ ownerId, companyId: id, value: inc.externalId, sourceSheet: row.sheet });
        for (const t of inc.tags) tagRows.push({ companyId: id, tag: t, kind: "industry" });
        if (inc.email) emails.push({ companyId: id, email: inc.email });
        importRows.push({ batchId, sheet: row.sheet, rowNumber: row.rowNumber, raw: row.raw, action: "merge_in_batch", entityType: "company", entityId: id, appliedFields: applied, issues: row.issues });
        report.merged++;
      } else if (row.action === "duplicate_review") {
        const irId = crypto.randomUUID();
        importRows.push({ id: irId, batchId, sheet: row.sheet, rowNumber: row.rowNumber, raw: row.raw, action: "duplicate_review", entityType: "company", entityId: row.duplicate!.companyId, issues: [...row.issues, row.duplicate!.reason] });
        await tx.insert(s.duplicateCandidates).values({ ownerId, batchId, importRowId: irId, existingCompanyId: row.duplicate!.companyId, incoming: { ...row.incoming!, sheet: row.sheet, rowNumber: row.rowNumber, priority: row.priority }, reason: row.duplicate!.reason });
        report.duplicatesForReview++;
      } else if (row.action === "invalid") {
        importRows.push({ batchId, sheet: row.sheet, rowNumber: row.rowNumber, raw: row.raw, action: "invalid", issues: row.issues });
        report.invalid++;
      }
    }

    // ── Evidence ──
    const extMap = new Map<string, string>();
    const allExt = await tx.select().from(s.companyExternalIds).where(eq(s.companyExternalIds.ownerId, ownerId));
    for (const e of allExt) extMap.set(e.value, e.companyId);
    for (const e of extIdRows) extMap.set(e.value!, e.companyId!);
    const evRows: (typeof s.companyEvidence.$inferInsert)[] = [];
    for (const row of plan.rows.filter((r) => r.action === "evidence" || r.action === "evidence_unmatched")) {
      const ev = row.evidence!;
      const companyId = ev.companyExternalId ? extMap.get(ev.companyExternalId) : undefined;
      if (!companyId) {
        importRows.push({ batchId, sheet: row.sheet, rowNumber: row.rowNumber, raw: row.raw, action: "invalid", issues: row.issues.length ? row.issues : ["Evidence row references an unknown company."] });
        report.evidenceUnmatched++;
        continue;
      }
      evRows.push({ ownerId, companyId, externalId: ev.evidenceId, fieldSupported: ev.fieldSupported, url: ev.url, publisher: ev.publisher, publishedDate: ev.publishedDate, accessedDate: ev.accessedDate, summary: ev.summary, source: "import" });
      importRows.push({ batchId, sheet: row.sheet, rowNumber: row.rowNumber, raw: row.raw, action: "evidence", entityType: "evidence", issues: [] });
      report.evidenceUpserted++;
    }
    for (const c of chunk(evRows, 300)) {
      await tx.insert(s.companyEvidence).values(c).onConflictDoUpdate({
        target: [s.companyEvidence.ownerId, s.companyEvidence.externalId],
        set: { fieldSupported: sql`excluded.field_supported`, url: sql`excluded.url`, publisher: sql`excluded.publisher`, publishedDate: sql`excluded.published_date`, accessedDate: sql`excluded.accessed_date`, summary: sql`excluded.summary` },
      });
    }

    for (const c of chunk(extIdRows, 500)) await tx.insert(s.companyExternalIds).values(c).onConflictDoNothing();
    for (const c of chunk(tagRows, 500)) await tx.insert(s.companyTags).values(c).onConflictDoNothing();
    for (const c of chunk(locRows, 300)) await tx.insert(s.companyLocations).values(c);

    // ── Emails from the sheet: an address, never evidence of outreach ──
    for (const { companyId, email } of emails) {
      if (!email) continue;
      let contactId: string | null = null;
      if (email.contactName) {
        const [c] = await tx.insert(s.contacts).values({ ownerId, companyId, fullName: email.contactName, title: email.contactTitle, source: "import", reviewStatus: "candidate" }).returning({ id: s.contacts.id });
        contactId = c.id;
      }
      const res = await tx.insert(s.emailAddresses).values({ ownerId, companyId, contactId, address: email.address, normalized: email.address, kind: classifyEmailKind(email.address), source: "import", sourceDetail: `import:${batchId}`, quality: "unknown" }).onConflictDoNothing().returning({ id: s.emailAddresses.id });
      if (res.length) report.emailsAdded++;
    }

    for (const c of chunk(importRows, 300)) await tx.insert(s.importRows).values(c);
    await tx.update(s.importBatches).set({ status: "committed", committedAt: now, report: { ...report, plannedCounts: plan.counts } }).where(eq(s.importBatches.id, batchId));
  });
  return report;
}

function locationFor(companyId: string, inc: NonNullable<PlanRow["incoming"]>): typeof s.companyLocations.$inferInsert {
  const country = (inc.fields.country as string | undefined) ?? null;
  const city = (inc.fields.city as string | undefined) ?? null;
  const tz = suggestTimezone(country, city);
  const hasCoords = inc.lat != null && inc.lng != null;
  return {
    companyId,
    kind: "hq",
    label: [city, country].filter(Boolean).join(", ") || null,
    city,
    country,
    countryCode: lookupCountry(country)?.code ?? null,
    lat: hasCoords ? inc.lat : null,
    lng: hasCoords ? inc.lng : null,
    precision: hasCoords ? "address" : city ? "city" : country ? "country" : "unknown",
    geocodeStatus: hasCoords ? "resolved" : country || city ? "pending" : "unresolved",
    geocodeProvider: hasCoords ? "imported" : null,
    timezone: tz.zone,
    isPrimary: true,
  };
}

async function refreshLocation(tx: DbOrTx, companyId: string, inc: NonNullable<PlanRow["incoming"]>) {
  const [loc] = await tx.select().from(s.companyLocations).where(and(eq(s.companyLocations.companyId, companyId), eq(s.companyLocations.isPrimary, true)));
  if (loc?.geocodeStatus === "manual") return; // manual corrections win
  const next = locationFor(companyId, inc);
  if (loc) await tx.update(s.companyLocations).set({ ...next, id: undefined }).where(eq(s.companyLocations.id, loc.id));
  else await tx.insert(s.companyLocations).values(next);
}

// ───────────────────────── Rollback ─────────────────────────
export interface RollbackDependency {
  companyId: string;
  companyName: string;
  reasons: string[];
}

export interface RollbackAnalysis {
  removable: string[];         // companies created by this batch and untouched since
  revertableFields: number;    // field updates whose current value still equals what the import wrote
  dependencies: RollbackDependency[];
}

export async function analyzeRollback(db: DbOrTx, ownerId: string, batchId: string): Promise<RollbackAnalysis> {
  const [batch] = await db.select().from(s.importBatches).where(and(eq(s.importBatches.id, batchId), eq(s.importBatches.ownerId, ownerId)));
  if (!batch || batch.status !== "committed") throw new Error("Only committed imports can be rolled back.");
  const rows = await db.select().from(s.importRows).where(eq(s.importRows.batchId, batchId));
  const added = rows.filter((r) => r.action === "add" && r.entityId).map((r) => r.entityId!);
  const deps: RollbackDependency[] = [];
  const removable: string[] = [];
  if (added.length) {
    const comps = await db.select().from(s.companies).where(inArray(s.companies.id, added));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = async (table: any, col: any) =>
      new Map((await db.select({ id: col, n: sql<number>`count(*)::int` }).from(table).where(inArray(col, added)).groupBy(col)).map((r) => [r.id as string, r.n]));
    const contactsN = await count(s.contacts, s.contacts.companyId);
    const messagesN = await count(s.messages, s.messages.companyId);
    const oppsN = await count(s.opportunities, s.opportunities.companyId);
    const tasksN = await count(s.tasks, s.tasks.companyId);
    const enrN = await count(s.enrollments, s.enrollments.companyId);
    const otherBatches = new Map((await db.select({ id: s.importRows.entityId, n: sql<number>`count(*)::int` }).from(s.importRows).where(and(inArray(s.importRows.entityId, added), sql`${s.importRows.batchId} <> ${batchId}`)).groupBy(s.importRows.entityId)).map((r) => [r.id as string, r.n]));
    for (const c of comps) {
      const reasons: string[] = [];
      if (contactsN.get(c.id)) reasons.push(`${contactsN.get(c.id)} contact(s)`);
      if (messagesN.get(c.id)) reasons.push(`${messagesN.get(c.id)} message(s)`);
      if (oppsN.get(c.id)) reasons.push(`${oppsN.get(c.id)} opportunity record(s)`);
      if (tasksN.get(c.id)) reasons.push(`${tasksN.get(c.id)} task(s)`);
      if (enrN.get(c.id)) reasons.push("outreach enrollment");
      if (otherBatches.get(c.id)) reasons.push("touched by a later import");
      if (c.revision > 1) reasons.push("edited after import");
      const manual = Object.values((c.fieldProvenance ?? {}) as Record<string, { source: string }>).some((p) => p.source !== "import");
      if (manual) reasons.push("has manual/provider field edits");
      if (reasons.length) deps.push({ companyId: c.id, companyName: c.name, reasons });
      else removable.push(c.id);
    }
  }
  let revertable = 0;
  for (const r of rows.filter((x) => x.action === "update" && x.entityId)) revertable += Object.keys((r.appliedFields ?? {}) as object).length;
  return { removable, revertableFields: revertable, dependencies: deps };
}

/**
 * Non-destructive rollback: deletes only untouched companies this import
 * created; reverts imported field values only where the current value still
 * equals what the import wrote. Companies with dependencies are kept and
 * listed for a manual correction workflow.
 */
export async function rollbackImport(db: Db, ownerId: string, batchId: string): Promise<{ removed: number; fieldsReverted: number; kept: RollbackDependency[] }> {
  return db.transaction(async (tx) => {
    const analysis = await analyzeRollback(tx, ownerId, batchId);
    if (analysis.removable.length) await tx.delete(s.companies).where(inArray(s.companies.id, analysis.removable));
    let reverted = 0;
    const rows = await tx.select().from(s.importRows).where(and(eq(s.importRows.batchId, batchId), eq(s.importRows.action, "update")));
    for (const r of rows) {
      if (!r.entityId) continue;
      const [cur] = await tx.select().from(s.companies).where(eq(s.companies.id, r.entityId));
      if (!cur) continue;
      const set: Record<string, unknown> = {};
      const prov = { ...(cur.fieldProvenance as Record<string, { batchId?: string }>) };
      for (const [field, v] of Object.entries((r.appliedFields ?? {}) as Record<string, { before: unknown; after: unknown }>)) {
        const col = COLUMN_OF[field as ScalarField];
        if (String(cur[col] ?? "") === String(v.after ?? "") && prov[field]?.batchId === batchId) {
          set[col] = v.before;
          delete prov[field];
          reverted++;
        }
      }
      if (Object.keys(set).length) await tx.update(s.companies).set({ ...set, fieldProvenance: prov, revision: sql`${s.companies.revision} + 1`, updatedAt: new Date() }).where(eq(s.companies.id, r.entityId));
    }
    await tx.delete(s.companyExternalIds).where(and(eq(s.companyExternalIds.ownerId, ownerId), sql`${s.companyExternalIds.companyId} NOT IN (SELECT id FROM companies)`));
    await tx.update(s.duplicateCandidates).set({ status: "dismissed", resolvedAt: new Date() }).where(and(eq(s.duplicateCandidates.batchId, batchId), eq(s.duplicateCandidates.status, "open")));
    await tx.update(s.importBatches).set({ status: analysis.dependencies.length ? "correction_needed" : "rolled_back", rolledBackAt: new Date(), report: sql`${s.importBatches.report} || ${JSON.stringify({ rollback: { removed: analysis.removable.length, fieldsReverted: reverted, kept: analysis.dependencies } })}::jsonb` }).where(eq(s.importBatches.id, batchId));
    await audit(tx, { ownerId, entityType: "import_batch", entityId: batchId, action: "rollback", after: { removed: analysis.removable.length, fieldsReverted: reverted, kept: analysis.dependencies.length } });
    return { removed: analysis.removable.length, fieldsReverted: reverted, kept: analysis.dependencies };
  });
}
