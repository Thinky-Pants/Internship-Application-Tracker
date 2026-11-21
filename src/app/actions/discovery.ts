"use server";
import { and, eq, isNotNull } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getServices } from "@/server/runtime";
import { back, errMessage } from "@/server/flash";
import * as s from "@/db/schema";
import { createDiscoveryJob, enrichContacts, setDiscoveryJobState } from "@/domain/discovery/service";
import { listCompanies, parseFilter } from "@/server/queries";

export async function createDiscoveryJobAction(fd: FormData) {
  const o = await requireOwner();
  try {
    const f = parseFilter(JSON.parse(String(fd.get("filter") ?? "{}")));
    const max = Math.min(500, Number(fd.get("max") ?? 50));
    const rows = (await listCompanies(o.id, f)).filter((r) => r.company.domain && !r.company.suppressed).slice(0, max);
    const titles = String(fd.get("titles") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const seniorities = String(fd.get("seniorities") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const job = await createDiscoveryJob(getServices(), { ownerId: o.id, companyIds: rows.map((r) => r.company.id), titles, seniorities, requestBudget: Number(fd.get("requestBudget") ?? 0) || null, maxPerCompany: Number(fd.get("perCompany") ?? 5) });
    back("/contacts", { msg: `Discovery job queued for ${job.totalItems} companies (highest priority first). The worker runs it within Apollo rate limits; pause or cancel any time.` });
  } catch (e) {
    back("/contacts", { err: errMessage(e) });
  }
}

export async function jobStateAction(fd: FormData) {
  const o = await requireOwner();
  await setDiscoveryJobState(getServices(), o.id, String(fd.get("jobId")), String(fd.get("action")) as "pause" | "resume" | "cancel");
  back("/contacts", { msg: "Job updated. Cancel affects only unstarted work." });
}

export async function batchEnrichAction(fd: FormData) {
  const o = await requireOwner();
  const ids = fd.getAll("contactId").map(String);
  if (!ids.length) back("/contacts", { err: "Select contacts to enrich." });
  const budget = Number(fd.get("budget") ?? 0);
  const r = await enrichContacts(getServices(), { ownerId: o.id, contactIds: ids, creditBudget: budget >= 0 ? budget : null });
  const by = r.results.reduce<Record<string, number>>((a, x) => ((a[x.outcome] = (a[x.outcome] ?? 0) + 1), a), {});
  back("/contacts", { msg: `Enrichment: ${Object.entries(by).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ") || "nothing to do"}; skipped ${r.plan.skipped.length}. Credits: ${r.creditsUsed} (actual where reported).` });
}

export async function retryFailedAttemptsAction() {
  const o = await requireOwner();
  const db = getServices().db;
  await db.update(s.discoveryAttempts).set({ status: "pending", retryAfter: null }).where(and(eq(s.discoveryAttempts.ownerId, o.id), eq(s.discoveryAttempts.status, "failed"), isNotNull(s.discoveryAttempts.jobId)));
  back("/contacts", { msg: "Retryable failures re-queued." });
}
