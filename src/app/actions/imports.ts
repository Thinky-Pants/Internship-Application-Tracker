"use server";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getServices } from "@/server/runtime";
import { back, errMessage } from "@/server/flash";
import * as s from "@/db/schema";
import { createBatch, loadBatch, planBatch, rememberMappings } from "@/server/import-service";
import { commitImport, rollbackImport } from "@/domain/import/commit";
import { planApolloCsv, commitApolloCsv } from "@/domain/discovery/apollo-csv";
import { fieldsForRole, type SheetConfig, type SheetRole, type Priority } from "@/domain/import/mapping";
import { importResults, decideResult } from "@/domain/ai/exchange";

export async function uploadImportAction(fd: FormData) {
  const o = await requireOwner();
  const file = fd.get("file");
  let id = "";
  try {
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a .xlsx or .csv file.");
    id = await createBatch(o.id, file.name, new Uint8Array(await file.arrayBuffer()), fd.get("kind") === "apollo_csv" ? "apollo_csv" : "workbook");
  } catch (e) {
    back("/imports", { err: errMessage(e) });
  }
  back(`/imports/${id}`, { msg: "Uploaded. Review sheet roles and column mappings, then preview." });
}

export async function saveMappingAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("batchId"));
  const loaded = await loadBatch(o.id, id);
  if (!loaded) back("/imports", { err: "Import not found." });
  const config = loaded!.config.map((c, i) => {
    const role = (String(fd.get(`role-${i}`) ?? c.role) as SheetRole);
    const priority = String(fd.get(`priority-${i}`) ?? c.priority) as Priority;
    const headerRow = Math.max(0, Number(fd.get(`header-${i}`) ?? c.headerRow + 1) - 1);
    const mapping: SheetConfig["mapping"] = {};
    for (const f of fieldsForRole(role)) {
      const v = fd.get(`map-${i}-${f.key}`);
      mapping[f.key] = v === null ? c.mapping[f.key] ?? null : v === "" ? null : Number(v);
    }
    return { ...c, role, priority, headerRow, mapping };
  });
  await getServices().db.update(s.importBatches).set({ sheetConfig: config }).where(eq(s.importBatches.id, id));
  back(`/imports/${id}?step=preview`, { msg: "Mapping saved. Preview below — nothing has been written yet." });
}

export async function commitImportAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("batchId"));
  let msg = "";
  try {
    const loaded = await loadBatch(o.id, id);
    if (!loaded) throw new Error("Import not found.");
    if (loaded.batch.status !== "previewed") throw new Error(`This import is already ${loaded.batch.status}.`);
    const svc = getServices();
    if (loaded.batch.kind === "apollo_csv") {
      const c = loaded.config[0];
      const sheet = loaded.grid.sheets[0];
      const plan = await planApolloCsv(svc, o.id, sheet.rows[c.headerRow] ?? [], sheet.rows.slice(c.headerRow + 1), c.mapping);
      const r = await commitApolloCsv(svc, o.id, id, plan);
      msg = `Apollo CSV committed: ${r.created} new contacts, ${r.updated} updated, ${r.emailsAdded} addresses, ${r.skipped} skipped (${r.unresolvedCompanies.length} unresolved companies).`;
    } else {
      // Re-plan against the current database state inside the commit path.
      const plan = await planBatch(o.id, loaded.grid, loaded.config);
      const resolutions: Record<string, "incoming" | "keep"> = {};
      for (const k of fd.getAll("take")) resolutions[String(k)] = "incoming";
      const r = await commitImport(svc.db, { ownerId: o.id, batchId: id, plan, resolutions });
      await rememberMappings(o.id, loaded.config);
      msg = `Committed: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.merged} merged within the file, ${r.duplicatesForReview} kept for duplicate review, ${r.invalid} invalid, ${r.evidenceUpserted} evidence rows.`;
    }
  } catch (e) {
    back(`/imports/${id}`, { err: errMessage(e) });
  }
  back(`/imports/${id}`, { msg });
}

export async function rollbackImportAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("batchId"));
  let msg = "";
  try {
    const r = await rollbackImport(getServices().db, o.id, id);
    msg = `Rolled back: removed ${r.removed} untouched companies, reverted ${r.fieldsReverted} field values. ${r.kept.length} companies kept because they have later work (listed below).`;
  } catch (e) {
    back(`/imports/${id}`, { err: errMessage(e) });
  }
  back(`/imports/${id}`, { msg });
}

export async function resolveDuplicateAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("id"));
  const decision = String(fd.get("decision"));
  const svc = getServices();
  const [d] = await svc.db.select().from(s.duplicateCandidates).where(and(eq(s.duplicateCandidates.id, id), eq(s.duplicateCandidates.ownerId, o.id)));
  if (!d || d.status !== "open") back("/imports", { err: "Already resolved." });
  const inc = d!.incoming as { externalId: string | null; fields: Record<string, unknown>; sheet: string; priority: string };
  if (decision === "link") {
    if (inc.externalId) await svc.db.insert(s.companyExternalIds).values({ ownerId: o.id, companyId: d!.existingCompanyId!, value: inc.externalId, sourceSheet: inc.sheet }).onConflictDoNothing();
    await svc.db.update(s.duplicateCandidates).set({ status: "linked_existing", resolvedAt: new Date() }).where(eq(s.duplicateCandidates.id, id));
    back("/imports?tab=duplicates", { msg: "Linked as the same company (its ID now matches on reimport). Existing values were kept." });
  }
  if (decision === "separate") {
    const f = inc.fields;
    await svc.db.insert(s.companies).values({ ownerId: o.id, name: String(f.name), externalId: inc.externalId, domain: (f.domain as string) ?? null, website: (f.website as string) ?? null, country: (f.country as string) ?? null, city: (f.city as string) ?? null, industryPrimary: (f.industryPrimary as string) ?? null, priority: inc.priority, sourceSheet: inc.sheet, importBatchId: d!.batchId });
    await svc.db.update(s.duplicateCandidates).set({ status: "created_separate", resolvedAt: new Date() }).where(eq(s.duplicateCandidates.id, id));
    back("/imports?tab=duplicates", { msg: "Created as a separate company." });
  }
  await svc.db.update(s.duplicateCandidates).set({ status: "dismissed", resolvedAt: new Date() }).where(eq(s.duplicateCandidates.id, id));
  back("/imports?tab=duplicates", { msg: "Dismissed." });
}

export async function importAiResultsAction(fd: FormData) {
  const o = await requireOwner();
  const file = fd.get("file");
  const text = file instanceof File && file.size ? await file.text() : String(fd.get("text") ?? "");
  const preview = await importResults(getServices(), o.id, text);
  const counts = preview.reduce<Record<string, number>>((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {});
  back("/imports?tab=ai", { msg: `AI results staged for review: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}. Nothing was applied, approved or sent.` });
}

export async function decideAiResultAction(fd: FormData) {
  const o = await requireOwner();
  try {
    await decideResult(getServices(), o.id, String(fd.get("id")), fd.get("decision") === "accept" ? "accept" : "reject", { mailboxId: String(fd.get("mailboxId") ?? "") || undefined, to: String(fd.get("to") ?? "").split(",").map((x) => x.trim()).filter(Boolean) });
  } catch (e) {
    back("/imports?tab=ai", { err: errMessage(e) });
  }
  back("/imports?tab=ai", { msg: "Decision recorded. Accepted drafts appear in Drafts & Review, unapproved." });
}
