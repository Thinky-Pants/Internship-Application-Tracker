"use server";
import { and, eq, sql } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getServices } from "@/server/runtime";
import { back, errMessage } from "@/server/flash";
import * as s from "@/db/schema";
import { audit } from "@/domain/audit";
import { addManualEmail, addCandidateAsContact, enrichContacts, searchCompany } from "@/domain/discovery/service";
import { setManualLocation } from "@/domain/geo/geocode";
import { pauseFollowupsFor } from "@/domain/outreach/sequences";
import { filterQuery, type CompanyFilter } from "@/server/queries";
import { lookupCountry, suggestTimezone } from "@/domain/normalize";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

async function ownedCompany(ownerId: string, id: string) {
  const [c] = await getServices().db.select().from(s.companies).where(and(eq(s.companies.id, id), eq(s.companies.ownerId, ownerId)));
  if (!c) throw new Error("Company not found.");
  return c;
}

export async function saveViewAction(fd: FormData) {
  const o = await requireOwner();
  const f = JSON.parse(String(fd.get("qs") ?? "{}")) as CompanyFilter;
  const view = String(fd.get("back") ?? "/companies");
  await getServices().db.insert(s.savedViews).values({ ownerId: o.id, name: String(fd.get("name")).slice(0, 80), view, filters: f });
  back(`${view}${filterQuery(f)}`, { msg: "View saved." });
}

export async function deleteViewAction(fd: FormData) {
  const o = await requireOwner();
  await getServices().db.delete(s.savedViews).where(and(eq(s.savedViews.id, String(fd.get("id"))), eq(s.savedViews.ownerId, o.id)));
  back("/companies", { msg: "View deleted." });
}

const EDITABLE = ["name", "website", "priority", "industryPrimary", "notes", "researchNotes", "nextAction", "careersUrl", "eligibilityNotes", "sizeText"] as const;

export async function updateCompanyAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("id"));
  const path = `/companies/${id}`;
  try {
    const c = await ownedCompany(o.id, id);
    const set: Record<string, unknown> = {};
    const prov = { ...(c.fieldProvenance as Record<string, unknown>) };
    const before: Record<string, unknown> = {};
    for (const k of EDITABLE) {
      if (!fd.has(k)) continue;
      const v = str(fd, k);
      if ((c as Record<string, unknown>)[k] !== v) {
        before[k] = (c as Record<string, unknown>)[k];
        set[k] = v ?? (k === "name" ? c.name : k === "priority" ? c.priority : null);
        prov[k] = { source: "manual", at: new Date().toISOString() };
      }
    }
    const due = str(fd, "nextActionDue");
    if (fd.has("nextActionDue")) set.nextActionDue = due ? new Date(due) : null;
    if (!Object.keys(set).length) back(path, { msg: "No changes." });
    await getServices().db.update(s.companies).set({ ...set, fieldProvenance: prov, revision: sql`${s.companies.revision} + 1`, updatedAt: new Date() }).where(eq(s.companies.id, id));
    await audit(getServices().db, { ownerId: o.id, entityType: "company", entityId: id, action: "manual_edit", before, after: set });
  } catch (e) {
    back(path, { err: errMessage(e) });
  }
  back(path, { msg: "Saved (manual edits are preserved on reimport)." });
}

export async function suppressCompanyAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("id"));
  const svc = getServices();
  const reason = str(fd, "reason") ?? "Do not contact";
  const on = fd.get("on") === "1";
  await svc.db.update(s.companies).set({ suppressed: on, suppressedReason: on ? reason : null, updatedAt: new Date() }).where(and(eq(s.companies.id, id), eq(s.companies.ownerId, o.id)));
  if (on) {
    await svc.db.insert(s.suppressions).values({ ownerId: o.id, scope: "company", value: id, reason }).onConflictDoNothing();
    await pauseFollowupsFor(svc, { ownerId: o.id, companyId: id, contactId: null, reason: `Company suppressed: ${reason}`, scope: "company" });
  } else await svc.db.delete(s.suppressions).where(and(eq(s.suppressions.ownerId, o.id), eq(s.suppressions.scope, "company"), eq(s.suppressions.value, id)));
  await audit(svc.db, { ownerId: o.id, entityType: "company", entityId: id, action: on ? "suppress" : "unsuppress", after: { reason } });
  back(`/companies/${id}`, { msg: on ? "Further outreach suppressed; pending sends paused." : "Suppression removed." });
}

export async function closeCompanyAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("id"));
  const on = fd.get("on") === "1";
  await getServices().db.update(s.companies).set({ outreachClosed: on, closedReason: on ? str(fd, "reason") : null }).where(and(eq(s.companies.id, id), eq(s.companies.ownerId, o.id)));
  back(`/companies/${id}`, { msg: on ? "Marked closed." : "Reopened." });
}

export async function addContactAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  try {
    await ownedCompany(o.id, companyId);
    const name = str(fd, "fullName");
    if (!name) throw new Error("Name is required.");
    const svc = getServices();
    const [c] = await svc.db.insert(s.contacts).values({ ownerId: o.id, companyId, fullName: name, firstName: name.split(/\s+/)[0], title: str(fd, "title"), linkedinUrl: str(fd, "linkedinUrl"), sourceUrl: str(fd, "sourceUrl"), source: "manual", reviewStatus: "reviewed" }).returning();
    const email = str(fd, "email");
    if (email) await addManualEmail(svc, { ownerId: o.id, companyId, contactId: c.id, address: email, source: str(fd, "sourceUrl") ? "website" : "manual", sourceUrl: str(fd, "sourceUrl") });
    await svc.db.update(s.companies).set({ discoveryStatus: "reviewed", discoveryUpdatedAt: new Date() }).where(eq(s.companies.id, companyId));
  } catch (e) {
    back(`/companies/${companyId}`, { err: errMessage(e) });
  }
  back(`/companies/${companyId}`, { msg: "Contact added." });
}

export async function addEmailAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  try {
    await ownedCompany(o.id, companyId);
    await addManualEmail(getServices(), { ownerId: o.id, companyId, contactId: str(fd, "contactId"), address: String(fd.get("address") ?? ""), source: (str(fd, "source") as "website" | "manual") ?? "manual", sourceUrl: str(fd, "sourceUrl") });
  } catch (e) {
    back(`/companies/${companyId}`, { err: errMessage(e) });
  }
  back(`/companies/${companyId}`, { msg: "Address recorded as unverified (it was not provider-checked)." });
}

export async function setPreferredContactAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  const contactId = String(fd.get("contactId"));
  const db = getServices().db;
  await ownedCompany(o.id, companyId);
  await db.update(s.contacts).set({ isPreferred: false }).where(eq(s.contacts.companyId, companyId));
  await db.update(s.contacts).set({ isPreferred: true }).where(and(eq(s.contacts.id, contactId), eq(s.contacts.companyId, companyId)));
  await db.update(s.companies).set({ preferredContactId: contactId }).where(eq(s.companies.id, companyId));
  back(`/companies/${companyId}`, { msg: "Primary contact set (alternates kept)." });
}

export async function addReminderAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = str(fd, "companyId");
  const due = str(fd, "dueAt");
  await getServices().db.insert(s.tasks).values({ ownerId: o.id, companyId, kind: str(fd, "kind") ?? "reminder", title: String(fd.get("title") ?? "Reminder").slice(0, 300), dueAt: due ? new Date(due) : null });
  back(companyId ? `/companies/${companyId}` : "/", { msg: "Reminder added." });
}

export async function completeTaskAction(fd: FormData) {
  const o = await requireOwner();
  await getServices().db.update(s.tasks).set({ status: String(fd.get("status") ?? "done"), completedAt: new Date() }).where(and(eq(s.tasks.id, String(fd.get("id"))), eq(s.tasks.ownerId, o.id)));
  back(String(fd.get("back") ?? "/"), { msg: "Task updated." });
}

export async function upsertOpportunityAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  const db = getServices().db;
  await ownedCompany(o.id, companyId);
  const id = str(fd, "id");
  const vals = { roleTitle: str(fd, "roleTitle") ?? "Engineering internship (unspecified)", stage: str(fd, "stage") ?? "prospect", season: str(fd, "season"), deadline: str(fd, "deadline"), locationText: str(fd, "locationText"), workingLanguage: str(fd, "workingLanguage"), visaInfo: str(fd, "visaInfo"), url: str(fd, "url"), nextAction: str(fd, "nextAction"), updatedAt: new Date() };
  if (id) {
    const [before] = await db.select().from(s.opportunities).where(eq(s.opportunities.id, id));
    await db.update(s.opportunities).set(vals).where(and(eq(s.opportunities.id, id), eq(s.opportunities.companyId, companyId)));
    await audit(db, { ownerId: o.id, entityType: "opportunity", entityId: id, action: "update", before: { stage: before?.stage }, after: { stage: vals.stage } });
    if (["interview", "offer", "rejected", "withdrawn", "closed"].includes(vals.stage)) await pauseFollowupsFor(getServices(), { ownerId: o.id, companyId, contactId: null, reason: `Opportunity stage: ${vals.stage}`, scope: "company" });
  } else await db.insert(s.opportunities).values({ ownerId: o.id, companyId, ...vals });
  back(`/companies/${companyId}`, { msg: "Opportunity saved." });
}

export async function apolloSearchAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  const titles = (str(fd, "titles") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const seniorities = (str(fd, "seniorities") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  let msg = "";
  try {
    const a = await searchCompany(getServices(), { ownerId: o.id, companyId, titles, seniorities });
    msg = a.outcome === "match_found" ? `Found ${(a.candidates as unknown[]).length} candidate(s). Select people to save, then enrich to reveal addresses.` : `Search finished: ${a.outcome?.replace(/_/g, " ")}${a.errorMessage ? ` — ${a.errorMessage}` : ""}.`;
  } catch (e) {
    back(`/companies/${companyId}`, { err: errMessage(e) });
  }
  back(`/companies/${companyId}#discovery`, { msg });
}

export async function saveCandidatesAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  const attemptId = String(fd.get("attemptId"));
  const picks = fd.getAll("pick").map(String);
  const svc = getServices();
  const [a] = await svc.db.select().from(s.discoveryAttempts).where(and(eq(s.discoveryAttempts.id, attemptId), eq(s.discoveryAttempts.ownerId, o.id)));
  const cands = (a?.candidates ?? []) as { apolloPersonId: string }[];
  const saved: string[] = [];
  for (const c of cands.filter((x) => picks.includes(x.apolloPersonId))) saved.push((await addCandidateAsContact(svc, { ownerId: o.id, companyId, candidate: c as never })).id);
  if (fd.get("enrich") === "1" && saved.length) {
    const budget = Number(str(fd, "budget") ?? "") || null;
    const r = await enrichContacts(svc, { ownerId: o.id, contactIds: saved, creditBudget: budget });
    const revealed = r.results.filter((x) => x.outcome === "email_revealed").length;
    back(`/companies/${companyId}#discovery`, { msg: `Saved ${saved.length}; enrichment revealed ${revealed} address(es); ${r.results.length - revealed} without an address. Credits used: ${r.creditsUsed} (actual where Apollo reports it).` });
  }
  back(`/companies/${companyId}#discovery`, { msg: `Saved ${saved.length} contact(s) (no email yet).` });
}

export async function enrichContactAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  const r = await enrichContacts(getServices(), { ownerId: o.id, contactIds: [String(fd.get("contactId"))], creditBudget: Number(str(fd, "budget") ?? "") || null });
  const res = r.results[0];
  back(`/companies/${companyId}`, { msg: res ? `Enrichment: ${res.outcome.replace(/_/g, " ")}${res.email ? ` (${res.email})` : ""}.` : r.plan.skipped[0]?.reason ?? "Nothing to enrich." });
}

export async function setLocationAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  try {
    const svc = getServices();
    const locId = str(fd, "locationId");
    const lat = Number(fd.get("lat"));
    const lng = Number(fd.get("lng"));
    if (locId) await setManualLocation(svc, o.id, locId, lat, lng);
    else {
      const [c] = await svc.db.select().from(s.companies).where(and(eq(s.companies.id, companyId), eq(s.companies.ownerId, o.id)));
      await svc.db.insert(s.companyLocations).values({ companyId, kind: "hq", city: c.city, country: c.country, countryCode: lookupCountry(c.country)?.code, lat, lng, precision: "address", geocodeStatus: "manual", geocodeProvider: "manual", isPrimary: true, timezone: suggestTimezone(c.country, c.city).zone });
    }
    const tz = str(fd, "timezone");
    if (tz && locId) await svc.db.update(s.companyLocations).set({ timezone: tz }).where(eq(s.companyLocations.id, locId));
  } catch (e) {
    back(`/companies/${companyId}`, { err: errMessage(e) });
  }
  back(`/companies/${companyId}`, { msg: "Location corrected manually (future imports will not overwrite it)." });
}

export async function setTimezoneAction(fd: FormData) {
  await requireOwner();
  const companyId = String(fd.get("companyId"));
  const tz = str(fd, "timezone");
  const { isValidZone } = await import("@/domain/scheduling/time");
  if (!tz || !isValidZone(tz)) back(`/companies/${companyId}`, { err: "Unknown IANA timezone." });
  await getServices().db.update(s.companyLocations).set({ timezone: tz }).where(and(eq(s.companyLocations.companyId, companyId), eq(s.companyLocations.isPrimary, true)));
  back(`/companies/${companyId}`, { msg: `Business timezone set to ${tz}.` });
}

export async function suppressEmailAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  const db = getServices().db;
  const [e] = await db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, String(fd.get("emailId"))), eq(s.emailAddresses.ownerId, o.id)));
  if (e) {
    await db.update(s.emailAddresses).set({ suppressed: true }).where(eq(s.emailAddresses.id, e.id));
    await db.insert(s.suppressions).values({ ownerId: o.id, scope: "address", value: e.normalized, reason: str(fd, "reason") ?? "Suppressed manually" }).onConflictDoNothing();
  }
  back(`/companies/${companyId}`, { msg: "Address suppressed." });
}
