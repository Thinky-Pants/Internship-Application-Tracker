"use server";
import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { requireOwner } from "@/server/auth";
import { getServices } from "@/server/runtime";
import { back, errMessage } from "@/server/flash";
import * as s from "@/db/schema";
import { approveCurrentRevision, createMessage, reviseMessage } from "@/domain/messages/compose";
import { renderTemplate } from "@/domain/templates";
import { buildTemplateValues } from "@/domain/outreach/personalize";
import { scheduleMessage, cancelSend, rescheduleSend, pauseSend, resumeSends, previewBatch, commitBatch, setGlobalPause, setCampaignPause, type BatchRequest } from "@/domain/scheduling/service";
import { resolveUncertain } from "@/domain/dispatch/dispatcher";
import { aiDraftEmail } from "@/domain/ai/assist";
import type { DstResolution, ScheduleMode } from "@/domain/scheduling/time";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

async function draftFromTemplate(ownerId: string, args: { companyId: string; contactId: string | null; templateId: string | null; mailboxId: string; cvVersionId: string | null; personalization?: string | null; campaignId?: string | null }) {
  const svc = getServices();
  const db = svc.db;
  const [tpl] = args.templateId ? await db.select().from(s.templates).where(and(eq(s.templates.id, args.templateId), eq(s.templates.ownerId, ownerId))) : [];
  const { values } = await buildTemplateValues(db, { ownerId, companyId: args.companyId, contactId: args.contactId, personalization: args.personalization });
  const r = tpl ? renderTemplate({ subject: tpl.subject, bodyHtml: tpl.bodyHtml, requiredPlaceholders: tpl.requiredPlaceholders as string[] }, values) : { subject: "", html: "<p></p>", missing: [], unknown: [] };
  let to: string[] = [];
  if (args.contactId) {
    const emails = await db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.contactId, args.contactId), eq(s.emailAddresses.suppressed, false)));
    const best = emails.filter((e) => e.bounceState !== "hard" && e.quality !== "invalid").sort((a, b) => (a.quality === "provider_verified" ? -1 : 0) - (b.quality === "provider_verified" ? -1 : 0))[0];
    if (best) to = [best.address];
  }
  const { message } = await createMessage(svc, {
    ownerId, companyId: args.companyId, contactId: args.contactId, templateId: tpl?.id ?? null, createdBy: tpl ? "template" : "user", campaignId: args.campaignId ?? null,
    content: { subject: r.subject, bodyHtml: r.html, to, cc: [], mailboxId: args.mailboxId, attachmentVersionIds: args.cvVersionId ? [args.cvVersionId] : [] },
  });
  return { message, missing: [...r.missing, ...r.unknown.map((u) => `unknown:${u}`)], noRecipient: !to.length };
}

export async function createDraftAction(fd: FormData) {
  const o = await requireOwner();
  let id = "";
  let note = "";
  try {
    const mailboxId = str(fd, "mailboxId");
    if (!mailboxId) throw new Error("Add a mailbox first (Settings → Outlook, or use the demo mailbox).");
    const r = await draftFromTemplate(o.id, { companyId: String(fd.get("companyId")), contactId: str(fd, "contactId"), templateId: str(fd, "templateId"), mailboxId, cvVersionId: str(fd, "cvVersionId"), personalization: str(fd, "personalization"), campaignId: str(fd, "campaignId") });
    id = r.message.id;
    const sequenceId = str(fd, "sequenceId");
    if (sequenceId) {
      const db = getServices().db;
      const [en] = await db.insert(s.enrollments).values({ ownerId: o.id, companyId: String(fd.get("companyId")), contactId: str(fd, "contactId"), campaignId: str(fd, "campaignId"), sequenceId }).returning();
      await db.update(s.messages).set({ enrollmentId: en.id }).where(eq(s.messages.id, id));
    }
    note = [r.missing.length ? `Fill in: ${r.missing.join(", ")}.` : "", r.noRecipient ? "No usable address for this contact — add a recipient." : ""].filter(Boolean).join(" ");
  } catch (e) {
    back(`/drafts/new?companyId=${fd.get("companyId")}`, { err: errMessage(e) });
  }
  back(`/drafts/${id}`, { msg: `Draft created. ${note}`.trim() });
}

export async function aiDraftAction(fd: FormData) {
  const o = await requireOwner();
  const companyId = String(fd.get("companyId"));
  const contactId = str(fd, "contactId");
  let id = "";
  try {
    const mailboxId = str(fd, "mailboxId");
    if (!mailboxId) throw new Error("Choose a mailbox.");
    const { result } = await aiDraftEmail(getServices(), o.id, companyId, contactId);
    const base = await draftFromTemplate(o.id, { companyId, contactId, templateId: null, mailboxId, cvVersionId: str(fd, "cvVersionId") });
    const [rev] = await getServices().db.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, base.message.currentRevisionId!));
    await reviseMessage(getServices(), { ownerId: o.id, messageId: base.message.id, createdBy: "ai_suggestion", content: { subject: result.subject, bodyHtml: result.bodyHtml, to: rev.toAddresses as string[], cc: [], mailboxId, attachmentVersionIds: (rev.attachments as { documentVersionId: string }[]).map((a) => a.documentVersionId) } });
    id = base.message.id;
    if (result.unsupportedClaims?.length) back(`/drafts/${id}`, { err: `AI flagged unsupported claims — review: ${result.unsupportedClaims.join("; ")}` });
  } catch (e) {
    back(`/drafts/new?companyId=${companyId}`, { err: errMessage(e) });
  }
  back(`/drafts/${id}`, { msg: "AI suggestion loaded as a draft. Review every sentence; it is not approved." });
}

export async function saveRevisionAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("messageId"));
  let msg = "";
  try {
    const r = await reviseMessage(getServices(), {
      ownerId: o.id, messageId: id,
      content: {
        subject: String(fd.get("subject") ?? ""),
        bodyHtml: String(fd.get("bodyHtml") ?? ""),
        to: String(fd.get("to") ?? "").split(/[,;]/),
        cc: String(fd.get("cc") ?? "").split(/[,;]/),
        mailboxId: String(fd.get("mailboxId")),
        attachmentVersionIds: fd.getAll("attachment").map(String).filter(Boolean),
      },
    });
    msg = r.unchanged ? "No content change — approval and schedule unaffected." : `Saved revision ${r.revision.revisionNo}.${r.revokedApproval ? " The previous approval was revoked." : ""}${r.supersededSends ? ` ${r.supersededSends} queued send(s) of the old revision were superseded and will not be sent.` : ""}`;
  } catch (e) {
    back(`/drafts/${id}`, { err: errMessage(e) });
  }
  back(`/drafts/${id}`, { msg });
}

export async function approveAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("messageId"));
  try {
    await approveCurrentRevision(getServices(), { ownerId: o.id, messageId: id });
  } catch (e) {
    back(`/drafts/${id}`, { err: errMessage(e) });
  }
  back(`/drafts/${id}`, { msg: "Approved this exact revision, recipients, mailbox and attachment versions. Scheduling it will not ask again unless something changes." });
}

export async function sendNowAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("messageId"));
  const svc = getServices();
  try {
    await approveCurrentRevision(svc, { ownerId: o.id, messageId: id, via: "send_now" });
    const [st] = await svc.db.select().from(s.settings).where(eq(s.settings.ownerId, o.id));
    const local = DateTime.fromJSDate(svc.clock.now(), { zone: st.displayTimezone }).plus({ minutes: 1 }).toFormat("yyyy-MM-dd'T'HH:mm");
    await scheduleMessage(svc, { ownerId: o.id, messageId: id, mode: "my_local", localIntent: local, zone: st.displayTimezone, respectWindow: false, dstResolution: "shift_forward" });
  } catch (e) {
    back(`/drafts/${id}`, { err: errMessage(e) });
  }
  back(`/drafts/${id}`, { msg: "Approved and queued to send within about a minute (the worker must be running). This is a planned send, not a delivery guarantee." });
}

export async function scheduleAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("messageId"));
  try {
    const mode = String(fd.get("mode")) as ScheduleMode;
    const [st] = await getServices().db.select().from(s.settings).where(eq(s.settings.ownerId, o.id));
    // "My timezone" always means the display timezone; the zone field applies to recipient-local mode only.
    const zone = mode === "my_local" ? st.displayTimezone : String(fd.get("zone"));
    await scheduleMessage(getServices(), { ownerId: o.id, messageId: id, mode, localIntent: `${fd.get("date")}T${fd.get("time")}`, zone, dstResolution: (str(fd, "dst") ?? "none") as DstResolution });
  } catch (e) {
    const d = (e as { details?: { options?: { resolution: string; label: string }[] } }).details;
    back(`/drafts/${id}`, { err: `${errMessage(e)}${d?.options?.length ? ` Choose: ${d.options.map((x) => `${x.resolution} = ${x.label}`).join("; ")}.` : ""}` });
  }
  back(`/schedule?msg=${encodeURIComponent("Scheduled.")}`);
}

export async function batchDraftsAction(fd: FormData) {
  const o = await requireOwner();
  const ids = fd.getAll("companyId").map(String);
  const templateId = str(fd, "templateId");
  const mailboxId = str(fd, "mailboxId");
  if (!ids.length || !mailboxId) back("/drafts?tab=batch", { err: "Select companies and a mailbox." });
  const db = getServices().db;
  let created = 0;
  let skipped = 0;
  for (const cid of ids.slice(0, 100)) {
    const [co] = await db.select().from(s.companies).where(and(eq(s.companies.id, cid), eq(s.companies.ownerId, o.id)));
    const contacts = await db.select().from(s.contacts).where(eq(s.contacts.companyId, cid));
    const contact = contacts.find((c) => c.id === co?.preferredContactId) ?? contacts[0];
    if (!co || co.suppressed || !contact) {
      skipped++;
      continue;
    }
    await draftFromTemplate(o.id, { companyId: cid, contactId: contact.id, templateId, mailboxId: mailboxId!, cvVersionId: str(fd, "cvVersionId"), campaignId: str(fd, "campaignId") });
    created++;
  }
  back("/drafts?tab=review", { msg: `Created ${created} drafts (${skipped} skipped: no contact or suppressed). Review, edit or exclude each one, then approve.` });
}

export async function batchApproveAction(fd: FormData) {
  const o = await requireOwner();
  const ids = fd.getAll("messageId").map(String);
  const errors: string[] = [];
  let ok = 0;
  for (const id of ids) {
    try {
      await approveCurrentRevision(getServices(), { ownerId: o.id, messageId: id, via: "batch" });
      ok++;
    } catch (e) {
      errors.push(errMessage(e));
    }
  }
  back("/drafts?tab=review", errors.length ? { err: `Approved ${ok}; ${errors.length} blocked: ${errors.slice(0, 3).join(" | ")}` } : { msg: `Approved ${ok} messages (exact revisions).` });
}

function batchReq(ownerId: string, fd: FormData): BatchRequest {
  const zoneOverrides: Record<string, string> = {};
  const dstResolutions: Record<string, DstResolution> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith("zone-") && String(v)) zoneOverrides[k.slice(5)] = String(v);
    if (k.startsWith("dst-") && String(v)) dstResolutions[k.slice(4)] = String(v) as DstResolution;
  }
  const when = String(fd.get("when") ?? "weekday");
  return {
    ownerId,
    messageIds: fd.getAll("messageId").map(String),
    mode: String(fd.get("mode") ?? "recipient_local") as ScheduleMode,
    nextWeekday: when === "weekday" ? Number(fd.get("weekday") ?? 1) : undefined,
    localDate: when === "date" ? String(fd.get("date")) : undefined,
    time: String(fd.get("time") ?? "07:00"),
    zoneOverrides,
    dstResolutions,
    excluded: fd.getAll("exclude").map(String),
  };
}

export async function batchScheduleAction(fd: FormData) {
  const o = await requireOwner();
  const req = batchReq(o.id, fd);
  const svc = getServices();
  const preview = await previewBatch(svc, req);
  if (fd.get("confirm") !== "1") {
    const qs = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (typeof v === "string") qs.append(k, v);
    back(`/schedule/batch?${qs.toString()}`);
  }
  const r = await commitBatch(svc, o.id, preview, req.mode);
  back("/schedule", { msg: `Scheduled ${r.created.length}; skipped ${r.skipped.length}.` });
}

// ── Queue controls ──
export async function cancelSendAction(fd: FormData) {
  const o = await requireOwner();
  const r = await cancelSend(getServices(), o.id, String(fd.get("sendId")));
  back(`/schedule?send=${fd.get("sendId")}`, r.result === "cancelled" ? { msg: "Cancelled before dispatch — it will not be sent." } : r.result === "cancel_requested" ? { msg: r.explanation } : { err: r.explanation });
}

export async function pauseSendAction(fd: FormData) {
  const o = await requireOwner();
  try {
    await pauseSend(getServices(), o.id, String(fd.get("sendId")));
  } catch (e) {
    back(`/schedule?send=${fd.get("sendId")}`, { err: errMessage(e) });
  }
  back(`/schedule?send=${fd.get("sendId")}`, { msg: "Paused." });
}

export async function resumeSendAction(fd: FormData) {
  const o = await requireOwner();
  const r = await resumeSends(getServices(), o.id, fd.getAll("sendId").map(String));
  back("/schedule", { msg: r.map((x) => `${x.state}: ${x.note}`).join(" · ") || "Nothing to resume." });
}

export async function rescheduleAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("sendId"));
  try {
    const r = await rescheduleSend(getServices(), o.id, id, { localIntent: `${fd.get("date")}T${fd.get("time")}`, zone: String(fd.get("zone")), mode: String(fd.get("mode")) as ScheduleMode, dstResolution: (str(fd, "dst") ?? "none") as DstResolution });
    back(`/schedule?send=${id}`, { msg: r.approvalPreserved ? "Rescheduled; approval kept because content and recipients are unchanged." : "This change requires re-approval; the old schedule was superseded." });
  } catch (e) {
    back(`/schedule?send=${id}`, { err: errMessage(e) });
  }
}

export async function resolveUncertainAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("sendId"));
  try {
    await resolveUncertain(getServices(), o.id, id, String(fd.get("decision")) as "mark_sent" | "retry_same_draft" | "cancel");
  } catch (e) {
    back(`/schedule?send=${id}`, { err: errMessage(e) });
  }
  back(`/schedule?send=${id}`, { msg: "Resolution recorded." });
}

export async function globalPauseAction(fd: FormData) {
  const o = await requireOwner();
  const on = fd.get("on") === "1";
  await setGlobalPause(getServices(), o.id, on, str(fd, "reason") ?? undefined);
  back("/schedule", { msg: on ? "All sending paused. Resuming later re-spreads recent overdue sends and holds stale ones — no burst." : "Global pause lifted. Use “Resume” on paused sends to re-plan them." });
}

export async function campaignPauseAction(fd: FormData) {
  const o = await requireOwner();
  await setCampaignPause(getServices(), o.id, String(fd.get("campaignId")), fd.get("on") === "1", str(fd, "reason") ?? undefined);
  back("/schedule", { msg: "Campaign updated." });
}

export async function createCampaignAction(fd: FormData) {
  const o = await requireOwner();
  await getServices().db.insert(s.campaigns).values({ ownerId: o.id, name: String(fd.get("name")).slice(0, 100) });
  back(String(fd.get("back") ?? "/schedule"), { msg: "Campaign created." });
}

export async function releaseHeldAction(fd: FormData) {
  const o = await requireOwner();
  const ids = fd.getAll("sendId").map(String);
  const db = getServices().db;
  const rows = ids.length ? await db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.ownerId, o.id), inArray(s.scheduledSends.id, ids))) : [];
  const r = await resumeSends(getServices(), o.id, rows.map((x) => x.id), { releaseStale: true });
  back("/schedule", { msg: r.map((x) => x.note).join(" · ") || "Nothing released." });
}
