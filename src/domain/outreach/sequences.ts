/**
 * Follow-up sequences. Delays anchor to the previous message's RECORDED sent
 * time (not its planned time). Follow-ups are created as in-thread reply
 * drafts awaiting review; they are new content, so they need their own
 * approval. Pending follow-ups pause when replies, rejections, opt-outs,
 * bounces, interviews, closure or manual pauses are recorded.
 */
import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import * as s from "@/db/schema";
import { renderTemplate } from "../templates";
import { buildTemplateValues } from "./personalize";
import { createMessage } from "../messages/compose";
import { logTransition } from "../dispatch/states";
import type { Services } from "../services";

export interface FollowupStep {
  step: number;
  delayDays: number;
  templateId: string;
}

export async function scheduleNextFollowup(svc: Services, sentMessageId: string) {
  const [msg] = await svc.db.select().from(s.messages).where(eq(s.messages.id, sentMessageId));
  if (!msg?.enrollmentId || !msg.recordedSentAt) return null;
  const [en] = await svc.db.select().from(s.enrollments).where(eq(s.enrollments.id, msg.enrollmentId));
  if (!en || en.state !== "active" || !en.sequenceId) return null;
  const [seq] = await svc.db.select().from(s.sequences).where(eq(s.sequences.id, en.sequenceId));
  const steps = (seq?.followups ?? []) as FollowupStep[];
  const next = steps.find((x) => x.step === msg.sequenceStep + 1);
  if (!next) {
    await svc.db.update(s.enrollments).set({ currentStep: msg.sequenceStep, updatedAt: svc.clock.now() }).where(eq(s.enrollments.id, en.id));
    return null;
  }
  const existing = await svc.db.select().from(s.messages).where(and(eq(s.messages.enrollmentId, en.id), eq(s.messages.sequenceStep, next.step)));
  if (existing.length) return existing[0];
  const [tpl] = await svc.db.select().from(s.templates).where(eq(s.templates.id, next.templateId));
  if (!tpl) return null;
  const { values } = await buildTemplateValues(svc.db, { ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, opportunityId: en.opportunityId });
  const r = renderTemplate({ ...tpl, requiredPlaceholders: tpl.requiredPlaceholders as string[] }, values);
  const [rev] = await svc.db.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, msg.currentRevisionId!));
  const subject = r.subject || (/^re:/i.test(rev.subject) ? rev.subject : `Re: ${rev.subject}`);
  const { message } = await createMessage(svc, {
    ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, kind: "followup", enrollmentId: en.id, campaignId: msg.campaignId, replyToMessageId: msg.id,
    sequenceStep: next.step, templateId: tpl.id, createdBy: "template", isDemo: msg.isDemo,
    content: { subject, bodyHtml: r.html, to: rev.toAddresses as string[], cc: [], mailboxId: rev.mailboxId!, attachmentVersionIds: [] },
  });
  const dueAt = DateTime.fromJSDate(msg.recordedSentAt).plus({ days: next.delayDays }).toJSDate();
  await svc.db.update(s.messages).set({ status: "awaiting_approval", conversationId: msg.conversationId }).where(eq(s.messages.id, message.id));
  await svc.db.insert(s.tasks).values({ ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, messageId: message.id, kind: "review", title: `Review follow-up #${next.step} (suggested ${next.delayDays} days after the recorded send)`, dueAt, isDemo: msg.isDemo });
  await svc.db.update(s.enrollments).set({ currentStep: msg.sequenceStep, updatedAt: svc.clock.now() }).where(eq(s.enrollments.id, en.id));
  return message;
}

/**
 * Pause pending follow-ups (and, by policy, other pending sends to the same
 * company). Returns the number of scheduled sends paused.
 */
export async function pauseFollowupsFor(svc: Services, args: { ownerId: string; companyId: string | null; contactId: string | null; reason: string; scope: "contact" | "company" }) {
  const now = svc.clock.now();
  const ens = await svc.db.select().from(s.enrollments).where(and(
    eq(s.enrollments.ownerId, args.ownerId),
    args.scope === "company" && args.companyId ? eq(s.enrollments.companyId, args.companyId) : args.contactId ? eq(s.enrollments.contactId, args.contactId) : eq(s.enrollments.id, "00000000-0000-0000-0000-000000000000"),
    eq(s.enrollments.state, "active"),
  ));
  for (const en of ens) await svc.db.update(s.enrollments).set({ state: "paused", pauseReason: args.reason, updatedAt: now }).where(eq(s.enrollments.id, en.id));
  const msgs = await svc.db.select({ id: s.messages.id }).from(s.messages).where(and(
    eq(s.messages.ownerId, args.ownerId), eq(s.messages.direction, "outbound"),
    args.scope === "company" && args.companyId ? eq(s.messages.companyId, args.companyId) : args.contactId ? eq(s.messages.contactId, args.contactId) : eq(s.messages.id, "00000000-0000-0000-0000-000000000000"),
  ));
  if (!msgs.length) return 0;
  const sends = await svc.db.select().from(s.scheduledSends).where(and(inArray(s.scheduledSends.messageId, msgs.map((m) => m.id)), inArray(s.scheduledSends.state, ["scheduled", "held"])));
  let n = 0;
  for (const sd of sends) {
    const [upd] = await svc.db.update(s.scheduledSends).set({ state: "paused", holdReason: args.reason, version: sd.version + 1, updatedAt: now }).where(and(eq(s.scheduledSends.id, sd.id), eq(s.scheduledSends.version, sd.version))).returning();
    if (upd) {
      n++;
      await svc.db.update(s.messages).set({ status: "paused" }).where(eq(s.messages.id, sd.messageId));
      await logTransition(svc.db, { ownerId: args.ownerId, scheduledSendId: sd.id, messageId: sd.messageId, from: sd.state, to: "paused", actor: "system", reason: args.reason, at: now });
    }
  }
  return n;
}
