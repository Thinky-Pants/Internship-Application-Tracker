"use server";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getServices } from "@/server/runtime";
import { back, errMessage } from "@/server/flash";
import * as s from "@/db/schema";
import { uploadCvVersion } from "@/domain/documents";
import { PLACEHOLDERS, scanPlaceholders } from "@/domain/templates";
import type { CandidateProfile } from "@/domain/outreach/personalize";

export async function uploadCvAction(fd: FormData) {
  const o = await requireOwner();
  const file = fd.get("file");
  try {
    if (!(file instanceof File) || !file.size) throw new Error("Choose a PDF.");
    const tags = String(fd.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    await uploadCvVersion(getServices(), { ownerId: o.id, documentId: String(fd.get("documentId") ?? "") || undefined, title: String(fd.get("title") ?? "") || file.name, description: String(fd.get("description") ?? "") || undefined, industryTags: tags.length ? tags : undefined, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()), note: String(fd.get("note") ?? "") || undefined });
  } catch (e) {
    back("/library", { err: errMessage(e) });
  }
  back("/library", { msg: "CV version stored. Messages already approved keep the exact earlier version." });
}

export async function archiveCvAction(fd: FormData) {
  const o = await requireOwner();
  await getServices().db.update(s.documents).set({ archived: fd.get("on") === "1" }).where(and(eq(s.documents.id, String(fd.get("documentId"))), eq(s.documents.ownerId, o.id)));
  back("/library", { msg: "Updated. Archived CVs stay attached to historical messages." });
}

export async function saveTemplateAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("id") ?? "");
  const subject = String(fd.get("subject") ?? "");
  const bodyHtml = String(fd.get("bodyHtml") ?? "");
  const unknown = [...new Set(scanPlaceholders(subject + bodyHtml).map((p) => p.name).filter((n) => !(n in PLACEHOLDERS)))];
  if (unknown.length) back("/library?tab=templates", { err: `Unknown placeholder(s): ${unknown.join(", ")}. Supported: ${Object.keys(PLACEHOLDERS).join(", ")}.` });
  const required = String(fd.get("required") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const vals = { name: String(fd.get("name") ?? "Template").slice(0, 100), kind: String(fd.get("kind") ?? "initial"), subject, bodyHtml, requiredPlaceholders: required, updatedAt: new Date() };
  const db = getServices().db;
  if (id) await db.update(s.templates).set(vals).where(and(eq(s.templates.id, id), eq(s.templates.ownerId, o.id)));
  else await db.insert(s.templates).values({ ownerId: o.id, ...vals });
  back("/library?tab=templates", { msg: "Template saved." });
}

function lines(v: FormDataEntryValue | null) {
  return String(v ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

export async function saveProfileAction(fd: FormData) {
  const o = await requireOwner();
  const ok = (k: string) => fd.get(`verify-${k}`) === "1";
  const projects = lines(fd.get("projects")).map((l) => {
    const [name, ...rest] = l.split(" — ");
    const [summary, skills] = rest.join(" — ").split(" | ");
    return { name: name.trim(), summary: (summary ?? "").trim(), skills: (skills ?? "").split(",").map((x) => x.trim()).filter(Boolean), verified: ok("projects") };
  });
  const data: CandidateProfile = {
    name: String(fd.get("name") ?? ""),
    email: String(fd.get("email") ?? ""),
    education: lines(fd.get("education")).map((text) => ({ text, verified: ok("education") })),
    skills: lines(fd.get("skills")).map((text) => ({ text, verified: ok("skills") })),
    projects,
    achievements: lines(fd.get("achievements")).map((text) => ({ text, verified: ok("achievements") })),
    availability: { text: String(fd.get("availability") ?? ""), verified: ok("availability") },
    statements: lines(fd.get("statements")).map((text) => ({ text, verified: ok("statements") })),
    workAuthorization: { text: String(fd.get("workAuthorization") ?? ""), verified: ok("workAuthorization") },
    signatureHtml: String(fd.get("signatureHtml") ?? ""),
  };
  await getServices().db.insert(s.candidateProfile).values({ ownerId: o.id, data }).onConflictDoUpdate({ target: s.candidateProfile.ownerId, set: { data, updatedAt: new Date() } });
  back("/library?tab=profile", { msg: "Profile saved. Only sections you confirmed as accurate are used in drafts and AI prompts." });
}

export async function saveSequenceAction(fd: FormData) {
  const o = await requireOwner();
  const steps = [1, 2, 3].map((i) => ({ step: i, delayDays: Number(fd.get(`delay-${i}`) ?? 0), templateId: String(fd.get(`tpl-${i}`) ?? "") })).filter((x) => x.delayDays > 0 && x.templateId);
  await getServices().db.insert(s.sequences).values({ ownerId: o.id, name: String(fd.get("name") ?? "Sequence").slice(0, 80), followups: steps });
  back("/library?tab=sequences", { msg: `Sequence saved with ${steps.length} follow-up(s). Delays count from the previous message's recorded send time.` });
}
