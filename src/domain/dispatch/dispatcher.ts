/**
 * Persistent dispatcher (runs only in the worker). See docs/DISPATCH.md.
 *
 * Guarantees it does provide:
 *  - Only one worker can hold a send: claims are compare-and-set on
 *    (state='scheduled', version) and set a lease.
 *  - The exact approved revision (content hash) is what gets submitted;
 *    anything else is superseded or held.
 *  - Crashes before the provider request are retried safely; crashes or
 *    timeouts after it become "uncertain" and are reconciled against the
 *    mailbox (draft / Sent Items) before any retry.
 * Guarantees it does NOT provide: exactly-once delivery, delivery confirmation,
 * or recall after submission.
 */
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import * as s from "@/db/schema";
import { errorSummary } from "@/lib/redact";
import { sha256Hex } from "@/lib/crypto";
import { readVersionBytes } from "../documents";
import { getMailAccess, handleAuthError, MailboxUnavailable } from "../mail/access";
import { enqueueJob } from "../jobs";
import { classifyOverdue, isWithinWindow, nextEligibleInstant, type SendingWindow } from "../scheduling/time";
import { logTransition } from "./states";
import { MailProviderError } from "@/providers/mail/types";
import type { AttachmentRef } from "../messages/compose";
import type { Services } from "../services";

type Send = typeof s.scheduledSends.$inferSelect;

export const LEASE_MS = 3 * 60_000;
export const MAX_PRESUBMIT_ATTEMPTS = 6;
/** How long a "submitted" send may lack a sent copy before it is flagged uncertain. */
export const SUBMITTED_RECONCILE_WINDOW_MS = 2 * 60 * 60_000;
export const MAX_RECONCILE_ATTEMPTS = 8;

export interface TickResult {
  recovered: number;
  claimed: number;
  submitted: number;
  held: number;
  deferred: number;
  uncertain: number;
  failed: number;
}

// ───────────────────────── helpers ─────────────────────────
async function transition(svc: Services, sd: Send, to: string, set: Partial<typeof s.scheduledSends.$inferInsert>, reason: string, opts: { requireLease?: boolean; messageStatus?: string; data?: Record<string, unknown> } = {}) {
  const now = svc.clock.now();
  const conds = [eq(s.scheduledSends.id, sd.id), eq(s.scheduledSends.state, sd.state)];
  if (opts.requireLease) conds.push(eq(s.scheduledSends.leaseOwner, svc.workerId));
  const [upd] = await svc.db.update(s.scheduledSends).set({ ...set, state: to, version: sql`${s.scheduledSends.version} + 1`, updatedAt: now }).where(and(...conds)).returning();
  if (!upd) return null;
  await svc.db.update(s.messages).set({ status: opts.messageStatus ?? to, updatedAt: now }).where(eq(s.messages.id, sd.messageId));
  await logTransition(svc.db, { ownerId: sd.ownerId, scheduledSendId: sd.id, messageId: sd.messageId, from: sd.state, to, reason, actor: `worker:${svc.workerId}`, data: opts.data, at: now });
  return upd;
}

const releaseLease = { leaseOwner: null, leaseExpiresAt: null } as const;

async function setPhase(svc: Services, sd: Send, phase: string, extra: Partial<typeof s.scheduledSends.$inferInsert> = {}) {
  const [upd] = await svc.db.update(s.scheduledSends).set({ phase, ...extra, leaseExpiresAt: new Date(svc.clock.now().getTime() + LEASE_MS), updatedAt: svc.clock.now() })
    .where(and(eq(s.scheduledSends.id, sd.id), eq(s.scheduledSends.state, "dispatching"), eq(s.scheduledSends.leaseOwner, svc.workerId))).returning();
  return upd ?? null;
}

/** Earliest instant the mailbox may submit again given limits/spacing/throttling. */
export async function nextAllowedForMailbox(svc: Services, mailbox: typeof s.mailboxes.$inferSelect, limitZone: string): Promise<{ at: Date; reason: string | null }> {
  const now = svc.clock.now();
  if (mailbox.throttledUntil && mailbox.throttledUntil > now) return { at: mailbox.throttledUntil, reason: "provider throttling (Retry-After)" };
  const dayStart = DateTime.fromJSDate(now, { zone: limitZone }).startOf("day").toJSDate();
  const recent = await svc.db.select({ t: s.scheduledSends.dispatchStartedAt }).from(s.scheduledSends).where(and(
    eq(s.scheduledSends.mailboxId, mailbox.id),
    inArray(s.scheduledSends.state, ["dispatching", "submitted", "recorded_sent", "uncertain"]),
    gte(s.scheduledSends.dispatchStartedAt, new Date(Math.min(dayStart.getTime(), now.getTime() - 3600_000))),
  )).orderBy(desc(s.scheduledSends.dispatchStartedAt));
  const times = recent.map((r) => r.t!.getTime());
  if (times.length && now.getTime() - times[0] < mailbox.minSpacingSeconds * 1000) return { at: new Date(times[0] + mailbox.minSpacingSeconds * 1000), reason: `minimum spacing ${mailbox.minSpacingSeconds}s` };
  const lastHour = times.filter((t) => t > now.getTime() - 3600_000);
  if (lastHour.length >= mailbox.hourlyLimit) return { at: new Date(lastHour[mailbox.hourlyLimit - 1] + 3600_000 + 1000), reason: `hourly limit ${mailbox.hourlyLimit}` };
  if (times.filter((t) => t >= dayStart.getTime()).length >= mailbox.dailyLimit) return { at: DateTime.fromJSDate(now, { zone: limitZone }).plus({ days: 1 }).startOf("day").toJSDate(), reason: `daily limit ${mailbox.dailyLimit}` };
  return { at: now, reason: null };
}

// ───────────────────────── recovery ─────────────────────────
export async function recoverExpiredLeases(svc: Services): Promise<number> {
  const now = svc.clock.now();
  const stuck = await svc.db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.state, "dispatching"), lte(s.scheduledSends.leaseExpiresAt, now)));
  let n = 0;
  for (const sd of stuck) {
    if (sd.phase === "send_requested") {
      // The provider may have received the send request. Never resend blindly.
      const upd = await transition(svc, sd, "uncertain", { ...releaseLease }, "worker lease expired after the send request — outcome unknown; reconciling with mailbox");
      if (upd) {
        await enqueueJob(svc.db, { ownerId: sd.ownerId, kind: "reconcile_send", payload: { sendId: sd.id }, runAt: now, dedupeKey: `reconcile:${sd.id}:${upd.version}` });
        n++;
      }
    } else {
      const upd = await transition(svc, sd, "scheduled", { ...releaseLease, phase: "queued", nextAttemptAt: now }, `worker lease expired in phase "${sd.phase}" (before any send request) — safe to retry`, { messageStatus: "scheduled" });
      if (upd) n++;
    }
  }
  return n;
}

// ───────────────────────── tick ─────────────────────────
export async function dispatchTick(svc: Services, opts: { limit?: number } = {}): Promise<TickResult> {
  const res: TickResult = { recovered: await recoverExpiredLeases(svc), claimed: 0, submitted: 0, held: 0, deferred: 0, uncertain: 0, failed: 0 };
  const now = svc.clock.now();
  const due = await svc.db.select().from(s.scheduledSends).where(and(
    eq(s.scheduledSends.state, "scheduled"),
    lte(s.scheduledSends.plannedAt, now),
    or(isNull(s.scheduledSends.nextAttemptAt), lte(s.scheduledSends.nextAttemptAt, now)),
  )).orderBy(s.scheduledSends.plannedAt).limit(opts.limit ?? 20);

  for (const sd of due) {
    const outcome = await dispatchOne(svc, sd);
    if (outcome === "skipped") continue;
    res.claimed++;
    if (outcome in res) (res as unknown as Record<string, number>)[outcome]++;
  }
  return res;
}

type Outcome = "skipped" | "submitted" | "held" | "deferred" | "uncertain" | "failed";

export async function dispatchOne(svc: Services, sdIn: Send): Promise<Outcome> {
  const now = svc.clock.now();
  const [st] = await svc.db.select().from(s.settings).where(eq(s.settings.ownerId, sdIn.ownerId));

  // Pre-claim gates that only defer (no claim needed).
  if (st.globalPause) {
    const upd = await transition(svc, sdIn, "paused", { holdReason: `Global pause: ${st.globalPauseReason ?? ""}`.trim() }, "global pause active");
    return upd ? "held" : "skipped";
  }
  const overdue = classifyOverdue(sdIn.nextAttemptAt && sdIn.nextAttemptAt > sdIn.plannedAt ? sdIn.nextAttemptAt : sdIn.plannedAt, now, st.missedSendGraceMinutes);
  if (overdue === "stale_overdue") {
    const upd = await transition(svc, sdIn, "held", { holdReason: `Missed its planned time by more than ${st.missedSendGraceMinutes} minutes (e.g. worker was offline). Review and reschedule or release.` }, "stale overdue — held instead of sending a backlog");
    return upd ? "held" : "skipped";
  }
  const [mb] = await svc.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, sdIn.mailboxId));
  if (mb && mb.status === "connected") {
    const gate = await nextAllowedForMailbox(svc, mb, st.displayTimezone);
    // Only a real limit defers (gate.at is read from a fresh clock and is never earlier than `now`).
    if (gate.reason && gate.at > now) {
      await svc.db.update(s.scheduledSends).set({ nextAttemptAt: gate.at, lastError: `Deferred: ${gate.reason}` }).where(and(eq(s.scheduledSends.id, sdIn.id), eq(s.scheduledSends.version, sdIn.version)));
      return "deferred";
    }
  }

  // ── Atomic claim (compare-and-set on state + version) ──
  const [sd] = await svc.db.update(s.scheduledSends).set({
    state: "dispatching", phase: "claimed", leaseOwner: svc.workerId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    version: sdIn.version + 1, attemptCount: sdIn.attemptCount + 1, dispatchStartedAt: now, attemptKey: `${sdIn.id}:${sdIn.attemptCount + 1}`, updatedAt: now,
  }).where(and(eq(s.scheduledSends.id, sdIn.id), eq(s.scheduledSends.state, "scheduled"), eq(s.scheduledSends.version, sdIn.version))).returning();
  if (!sd) return "skipped"; // another worker claimed it, or it was cancelled/edited
  await svc.db.update(s.messages).set({ status: "dispatching" }).where(eq(s.messages.id, sd.messageId));
  await logTransition(svc.db, { ownerId: sd.ownerId, scheduledSendId: sd.id, messageId: sd.messageId, from: "scheduled", to: "dispatching", reason: `claimed (attempt ${sd.attemptCount})`, actor: `worker:${svc.workerId}`, at: now });
  const [attempt] = await svc.db.insert(s.dispatchAttempts).values({ scheduledSendId: sd.id, attemptNo: sd.attemptCount, workerId: svc.workerId, startedAt: now }).returning();
  const finishAttempt = (outcome: string, extra: Partial<typeof s.dispatchAttempts.$inferInsert> = {}) =>
    svc.db.update(s.dispatchAttempts).set({ outcome, finishedAt: svc.clock.now(), ...extra }).where(eq(s.dispatchAttempts.id, attempt.id));

  const hold = async (reason: string, to: "held" | "paused" | "superseded" | "scheduled" = "held", set: Partial<typeof s.scheduledSends.$inferInsert> = {}) => {
    await transition(svc, sd, to, { ...releaseLease, phase: "queued", holdReason: reason, ...set }, reason, { requireLease: true, messageStatus: to === "superseded" ? "awaiting_approval" : to });
    await finishAttempt(to === "scheduled" ? "deferred" : "held", { errorSummary: reason });
    return (to === "scheduled" ? "deferred" : "held") as Outcome;
  };

  // ── Eligibility recheck under the claim ──
  const elig = await checkEligibility(svc, sd);
  if (elig) return hold(elig.reason, elig.to, elig.set);

  // ── Prepare provider draft ──
  let access;
  try {
    access = await getMailAccess(svc, sd.mailboxId);
  } catch (e) {
    const reason = e instanceof MailboxUnavailable ? `Mailbox ${e.status}: ${e.reason}` : errorSummary(e);
    if (e instanceof MailboxUnavailable && e.status === "connected") return hold(`Temporary: ${e.reason}`, "scheduled", { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) });
    return hold(`${reason} — schedule kept; reconnect to resume.`);
  }
  const [msg] = await svc.db.select().from(s.messages).where(eq(s.messages.id, sd.messageId));
  const [rev] = await svc.db.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, sd.revisionId));

  try {
    let draftId = msg.providerDraftId && msg.providerDraftRevisionId === rev.id ? msg.providerDraftId : null;
    if (draftId) {
      const state = await access.provider.getDraftState(access.ctx, draftId, { conversationId: msg.providerConversationId, since: sd.createdAt });
      if (state.exists && !state.isDraft) {
        // Already sent (e.g. crash after the send request): reconcile, never resend.
        await transition(svc, sd, "submitted", { ...releaseLease, phase: "done", submittedAt: now }, "provider draft is no longer a draft — treating as submitted and reconciling", { requireLease: true });
        await enqueueJob(svc.db, { ownerId: sd.ownerId, kind: "reconcile_send", payload: { sendId: sd.id }, runAt: now, dedupeKey: `reconcile:${sd.id}:found-sent` });
        await finishAttempt("submitted", { errorSummary: "found already sent" });
        return "submitted";
      }
      if (!state.exists) return hold("The Outlook draft for this message was deleted outside the app. Review before sending again.");
      if (state.fingerprint !== msg.providerDraftFingerprint) return hold("The Outlook draft was changed outside this app after approval. It will not be sent under the old approval — review it.");
    } else {
      if (msg.providerDraftId && msg.providerDraftRevisionId !== rev.id) {
        await access.provider.deleteDraft(access.ctx, msg.providerDraftId).catch(() => undefined); // stale draft of an older revision
      }
      const attachments = [];
      for (const a of rev.attachments as AttachmentRef[]) {
        const { version, bytes } = await readVersionBytes(svc, a.documentVersionId);
        if (sha256Hex(bytes) !== a.sha256) return hold(`Attachment ${a.filename} no longer matches the approved file hash.`);
        attachments.push({ filename: version.filename, contentType: version.mimeType, bytes });
      }
      let replyTo: string | null = null;
      if (msg.replyToMessageId) {
        const [parent] = await svc.db.select().from(s.messages).where(eq(s.messages.id, msg.replyToMessageId));
        replyTo = parent?.providerMessageId ?? null;
        if (!replyTo) return hold("The message this replies to has no provider ID yet (not synced); cannot thread the reply.");
      }
      const draft = await access.provider.createDraft(access.ctx, { subject: rev.subject, html: rev.bodyHtml, text: rev.bodyText, to: rev.toAddresses as string[], cc: rev.ccAddresses as string[], attachments, replyToProviderMessageId: replyTo });
      draftId = draft.draftId;
      await svc.db.update(s.messages).set({ providerDraftId: draft.draftId, providerDraftFingerprint: draft.fingerprint, providerDraftRevisionId: rev.id, internetMessageId: draft.internetMessageId, providerConversationId: draft.conversationId }).where(eq(s.messages.id, msg.id));
    }
    const ready = await setPhase(svc, sd, "draft_ready");
    if (!ready) return "skipped";

    // ── Cancellation cutoff: final recheck under the lease, then mark send_requested atomically ──
    const [fresh] = await svc.db.select().from(s.scheduledSends).where(eq(s.scheduledSends.id, sd.id));
    if (fresh.cancelRequestedAt) {
      await access.provider.deleteDraft(access.ctx, draftId).catch(() => undefined);
      await transition(svc, { ...sd, state: "dispatching" }, "cancelled", { ...releaseLease, phase: "done", cancelledAt: now }, "cancel requested before the provider send request — not sent", { requireLease: true });
      await finishAttempt("skipped", { errorSummary: "cancelled under claim" });
      return "held";
    }
    const recheck = await checkEligibility(svc, sd);
    if (recheck) return hold(recheck.reason, recheck.to, recheck.set);
    const marked = await svc.db.update(s.scheduledSends).set({ phase: "send_requested", leaseExpiresAt: new Date(svc.clock.now().getTime() + LEASE_MS) })
      .where(and(eq(s.scheduledSends.id, sd.id), eq(s.scheduledSends.state, "dispatching"), eq(s.scheduledSends.leaseOwner, svc.workerId), isNull(s.scheduledSends.cancelRequestedAt))).returning();
    if (!marked.length) {
      await access.provider.deleteDraft(access.ctx, draftId).catch(() => undefined);
      await transition(svc, { ...sd, state: "dispatching" }, "cancelled", { ...releaseLease, phase: "done", cancelledAt: now }, "cancel requested before the provider send request — not sent", { requireLease: true });
      await finishAttempt("skipped", { errorSummary: "cancelled at cutoff" });
      return "held";
    }

    // ── Provider submission ──
    const r = await access.provider.sendDraft(access.ctx, draftId);
    await transition(svc, sd, "submitted", { ...releaseLease, phase: "done", submittedAt: svc.clock.now(), lastError: null }, "provider accepted the send request (submission evidence only — not delivery)", { requireLease: true, data: { requestId: r.requestId } });
    await svc.db.update(s.messages).set({ submittedAt: svc.clock.now() }).where(eq(s.messages.id, msg.id));
    await finishAttempt("submitted", { providerRequestId: r.requestId, httpStatus: 202 });
    await enqueueJob(svc.db, { ownerId: sd.ownerId, kind: "reconcile_send", payload: { sendId: sd.id }, runAt: new Date(svc.clock.now().getTime() + 30_000), dedupeKey: `reconcile:${sd.id}:submitted` });
    return "submitted";
  } catch (e) {
    return handleDispatchError(svc, sd, e, finishAttempt);
  }
}

async function handleDispatchError(svc: Services, sd: Send, e: unknown, finishAttempt: (o: string, x?: Partial<typeof s.dispatchAttempts.$inferInsert>) => Promise<unknown>): Promise<Outcome> {
  const now = svc.clock.now();
  const [cur] = await svc.db.select().from(s.scheduledSends).where(eq(s.scheduledSends.id, sd.id));
  const sendRequested = cur?.phase === "send_requested";
  const summary = errorSummary(e);
  const pe = e instanceof MailProviderError ? e : null;
  const base = { ...cur, state: "dispatching" } as Send;

  if (pe && (pe.kind === "auth_expired" || pe.kind === "consent_required")) {
    await handleAuthError(svc, sd.mailboxId, pe);
    if (!sendRequested) {
      await transition(svc, base, "held", { ...releaseLease, phase: "queued", holdReason: "Mailbox needs reconnecting. Schedule kept.", lastError: summary }, "mailbox authorisation failed before submission", { requireLease: true });
      await finishAttempt("held", { errorSummary: summary, httpStatus: pe.opts.status });
      return "held";
    }
  }
  if (pe && pe.kind === "throttled" ) {
    // A 429 means the request was refused — safe to retry after Retry-After.
    const retryMs = (pe.opts.retryAfterSeconds ?? 60) * 1000;
    await svc.db.update(s.mailboxes).set({ throttledUntil: new Date(now.getTime() + retryMs) }).where(eq(s.mailboxes.id, sd.mailboxId));
    await transition(svc, base, "scheduled", { ...releaseLease, phase: sendRequested ? "draft_ready" : "queued", nextAttemptAt: new Date(now.getTime() + retryMs), lastError: `Throttled; retry after ${Math.round(retryMs / 1000)}s` }, "provider throttled (Retry-After respected)", { requireLease: true, messageStatus: "scheduled" });
    await finishAttempt("retryable_failure", { errorSummary: summary, httpStatus: 429 });
    return "deferred";
  }
  if (sendRequested && (!pe || pe.kind === "ambiguous" || pe.kind === "transient")) {
    await transition(svc, base, "uncertain", { ...releaseLease, phase: "send_requested", lastError: summary }, "send request outcome unknown (timeout/connection error after request) — reconciling, no blind resend", { requireLease: true });
    await finishAttempt("uncertain", { errorSummary: summary, httpStatus: pe?.opts.status });
    await enqueueJob(svc.db, { ownerId: sd.ownerId, kind: "reconcile_send", payload: { sendId: sd.id }, runAt: new Date(now.getTime() + 30_000), dedupeKey: `reconcile:${sd.id}:${cur?.version}` });
    return "uncertain";
  }
  const retryable = !pe || pe.kind === "transient" || pe.kind === "ambiguous";
  if (retryable && sd.attemptCount < MAX_PRESUBMIT_ATTEMPTS) {
    const backoff = Math.min(60, 2 ** sd.attemptCount) * 60_000;
    await transition(svc, base, "scheduled", { ...releaseLease, phase: "queued", nextAttemptAt: new Date(now.getTime() + backoff), lastError: summary }, `pre-submission failure, retry in ${backoff / 60000} min`, { requireLease: true, messageStatus: "scheduled" });
    await finishAttempt("retryable_failure", { errorSummary: summary, httpStatus: pe?.opts.status });
    return "deferred";
  }
  await transition(svc, base, "failed", { ...releaseLease, phase: "queued", lastError: summary }, `terminal failure: ${summary}`, { requireLease: true });
  await finishAttempt("terminal_failure", { errorSummary: summary, httpStatus: pe?.opts.status });
  return "failed";
}

/** Returns a hold decision or null if eligible. Rechecked under the claim and again right before sending. */
async function checkEligibility(svc: Services, sd: Send): Promise<{ reason: string; to: "held" | "paused" | "superseded" | "scheduled"; set?: Partial<typeof s.scheduledSends.$inferInsert> } | null> {
  const now = svc.clock.now();
  const [st] = await svc.db.select().from(s.settings).where(eq(s.settings.ownerId, sd.ownerId));
  if (st.globalPause) return { reason: `Global pause: ${st.globalPauseReason ?? "paused"}`, to: "paused" };
  const [msg] = await svc.db.select().from(s.messages).where(eq(s.messages.id, sd.messageId));
  if (!msg) return { reason: "Message deleted.", to: "held" };
  if (msg.currentRevisionId !== sd.revisionId) return { reason: "A newer revision exists; this queued revision will never be sent.", to: "superseded" };
  const [rev] = await svc.db.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, sd.revisionId));
  const [ap] = sd.approvalId ? await svc.db.select().from(s.approvals).where(eq(s.approvals.id, sd.approvalId)) : [];
  if (!ap || ap.revokedAt || ap.revisionId !== rev.id || ap.contentHash !== rev.contentHash || ap.mailboxId !== sd.mailboxId) return { reason: "Approval no longer matches this exact content/mailbox.", to: "superseded" };
  if (sd.campaignId) {
    const [c] = await svc.db.select().from(s.campaigns).where(eq(s.campaigns.id, sd.campaignId));
    if (c?.paused) return { reason: `Campaign "${c.name}" is paused${c.pausedReason ? `: ${c.pausedReason}` : ""}.`, to: "paused" };
  }
  // Recipients: suppression, bounces, invalid.
  const recips = [...(rev.toAddresses as string[]), ...(rev.ccAddresses as string[])];
  const emails = recips.length ? await svc.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.ownerId, sd.ownerId), inArray(s.emailAddresses.normalized, recips))) : [];
  for (const e of emails) {
    if (e.suppressed) return { reason: `${e.address} is suppressed.`, to: "held" };
    if (e.bounceState === "hard") return { reason: `${e.address} hard-bounced; find a replacement contact.`, to: "held" };
    if (e.quality === "invalid") return { reason: `${e.address} is marked invalid.`, to: "held" };
  }
  const supp = recips.length ? await svc.db.select().from(s.suppressions).where(and(eq(s.suppressions.ownerId, sd.ownerId), inArray(s.suppressions.value, [...recips, ...recips.map((r) => r.split("@")[1]), ...(msg.companyId ? [msg.companyId] : []), ...(msg.contactId ? [msg.contactId] : [])]))) : [];
  if (supp.length) return { reason: `Suppressed (${supp[0].scope}): ${supp[0].reason}`, to: "held" };
  if (msg.companyId) {
    const [co] = await svc.db.select().from(s.companies).where(eq(s.companies.id, msg.companyId));
    if (co?.suppressed) return { reason: `${co.name} is suppressed: ${co.suppressedReason ?? ""}`, to: "held" };
    if (co?.outreachClosed) return { reason: `${co.name} outreach is closed: ${co.closedReason ?? ""}`, to: "held" };
    // Stop if a human reply arrived from this company since the send was scheduled.
    const replies = await svc.db.select({ id: s.messages.id, category: s.messages.category }).from(s.messages).where(and(
      eq(s.messages.companyId, msg.companyId), eq(s.messages.direction, "inbound"), eq(s.messages.isAutomated, false), eq(s.messages.isBounce, false), gt(s.messages.receivedAt, sd.createdAt),
    ));
    if (replies.length && (st.companyCoordinationPolicy === "pause_company" || msg.contactId)) {
      return { reason: `A reply from ${co?.name ?? "this company"} arrived after scheduling (${replies[0].category ?? "uncategorised"}). Review before sending more.`, to: "held" };
    }
  }
  if (msg.enrollmentId) {
    const [en] = await svc.db.select().from(s.enrollments).where(eq(s.enrollments.id, msg.enrollmentId));
    if (en && en.state !== "active") return { reason: `Sequence ${en.state}: ${en.pauseReason ?? en.stopReason ?? ""}`.trim(), to: "held" };
  }
  if (msg.kind === "followup") {
    const [mb] = await svc.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, sd.mailboxId));
    const maxAge = st.followupMaxSyncAgeMinutes * 60_000;
    if (!mb?.lastSyncAt || now.getTime() - mb.lastSyncAt.getTime() > maxAge) {
      return { reason: `Follow-up held: mailbox last synced ${mb?.lastSyncAt ? Math.round((now.getTime() - mb.lastSyncAt.getTime()) / 60000) + " min ago" : "never"} (limit ${st.followupMaxSyncAgeMinutes} min). A reply could be missing. It will be re-evaluated after the next successful sync.`, to: "held", set: { lastError: "sync_stale" } };
    }
    if (msg.conversationId) {
      const inbound = await svc.db.select({ id: s.messages.id }).from(s.messages).where(and(eq(s.messages.conversationId, msg.conversationId), eq(s.messages.direction, "inbound"), ne(s.messages.id, msg.id)));
      if (inbound.length) return { reason: "The recipient replied in this thread; follow-up stopped pending review.", to: "held" };
    }
  }
  // Sending window (in the schedule's zone).
  const win = st.sendingWindow as SendingWindow;
  if (!isWithinWindow(now, sd.intentZone, win)) {
    const next = nextEligibleInstant(now, sd.intentZone, win);
    return { reason: `Outside the sending window in ${sd.intentZone}; next eligible ${next.toISOString()}.`, to: "scheduled", set: { nextAttemptAt: next } };
  }
  return null;
}

// ───────────────────────── reconciliation ─────────────────────────
/**
 * Establish what happened to a submitted/uncertain send using the mailbox:
 *  - Sent copy found → recorded_sent (timestamp from provider).
 *  - Uncertain and the draft still exists as a draft after the wait → the send
 *    was most likely not processed, but this is NOT certain: require a visible
 *    resolution (retry sends the SAME draft, which the provider cannot send twice).
 */
export async function reconcileSend(svc: Services, sendId: string): Promise<string> {
  const now = svc.clock.now();
  const [sd] = await svc.db.select().from(s.scheduledSends).where(eq(s.scheduledSends.id, sendId));
  if (!sd || !["submitted", "uncertain"].includes(sd.state)) return "noop";
  const [msg] = await svc.db.select().from(s.messages).where(eq(s.messages.id, sd.messageId));
  let access;
  try {
    access = await getMailAccess(svc, sd.mailboxId);
  } catch (e) {
    await svc.db.update(s.scheduledSends).set({ lastError: `Reconcile waiting: ${errorSummary(e)}` }).where(eq(s.scheduledSends.id, sd.id));
    return "mailbox_unavailable";
  }
  if (!msg.providerDraftId) {
    await transition(svc, sd, sd.state, { resolutionRequired: true, lastError: "No provider draft recorded; cannot reconcile automatically." }, "needs manual resolution");
    return "resolution_required";
  }
  const copy = await access.provider.findSentCopy(access.ctx, { draftId: msg.providerDraftId, internetMessageId: msg.internetMessageId, conversationId: msg.providerConversationId, since: sd.createdAt });
  if (copy) {
    await transition(svc, sd, "recorded_sent", { recordedSentAt: copy.sentAt, resolutionRequired: false, lastError: null }, `sent copy found in Sent Items (${copy.sentAt.toISOString()})`, { messageStatus: "recorded_sent" });
    await svc.db.update(s.messages).set({ recordedSentAt: copy.sentAt, providerMessageId: copy.providerMessageId, internetMessageId: copy.internetMessageId ?? msg.internetMessageId, providerConversationId: copy.conversationId ?? msg.providerConversationId, webLink: copy.webLink, evidenceSource: "provider_sync" }).where(eq(s.messages.id, msg.id));
    await afterRecordedSent(svc, msg.id);
    return "recorded_sent";
  }
  const attempts = sd.reconcileAttempts + 1;
  const age = now.getTime() - (sd.submittedAt ?? sd.dispatchStartedAt ?? sd.updatedAt).getTime();
  if (sd.state === "submitted" && age > SUBMITTED_RECONCILE_WINDOW_MS) {
    await transition(svc, sd, "uncertain", { reconcileAttempts: attempts, lastError: "Accepted by provider but no sent copy found yet." }, "no sent copy after the reconcile window");
    return "uncertain";
  }
  if (sd.state === "uncertain" && attempts >= MAX_RECONCILE_ATTEMPTS) {
    const draft = await access.provider.getDraftState(access.ctx, msg.providerDraftId, { conversationId: msg.providerConversationId, since: sd.createdAt });
    const note = draft.exists && draft.isDraft ? "The draft is still in Drafts, so it was probably not sent — but this cannot be proven." : "No draft and no sent copy were found.";
    await svc.db.update(s.scheduledSends).set({ reconcileAttempts: attempts, resolutionRequired: true, lastError: `Outcome unresolved. ${note} Choose: mark as sent, retry (same draft), or cancel.` }).where(eq(s.scheduledSends.id, sd.id));
    return "resolution_required";
  }
  await svc.db.update(s.scheduledSends).set({ reconcileAttempts: attempts }).where(eq(s.scheduledSends.id, sd.id));
  await enqueueJob(svc.db, { ownerId: sd.ownerId, kind: "reconcile_send", payload: { sendId: sd.id }, runAt: new Date(now.getTime() + Math.min(30, 2 ** attempts) * 60_000), dedupeKey: `reconcile:${sd.id}:try${attempts}` });
  return "pending";
}

/** Manual resolution of an uncertain send (explicit user decision). */
export async function resolveUncertain(svc: Services, ownerId: string, sendId: string, decision: "mark_sent" | "retry_same_draft" | "cancel") {
  const [sd] = await svc.db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.id, sendId), eq(s.scheduledSends.ownerId, ownerId)));
  if (!sd || sd.state !== "uncertain") throw new Error("Only uncertain sends can be resolved.");
  const now = svc.clock.now();
  if (decision === "mark_sent") {
    await transition(svc, sd, "recorded_sent", { recordedSentAt: now, resolutionRequired: false }, "marked sent by owner (manual evidence)", { messageStatus: "recorded_sent" });
    await svc.db.update(s.messages).set({ recordedSentAt: now, evidenceSource: "manual" }).where(eq(s.messages.id, sd.messageId));
    await afterRecordedSent(svc, sd.messageId);
  } else if (decision === "retry_same_draft") {
    // Re-queue with phase draft_ready: the dispatcher re-checks the draft; a draft already sent is detected and never resent.
    await transition(svc, sd, "scheduled", { phase: "queued", resolutionRequired: false, nextAttemptAt: now, plannedAt: now }, "owner chose retry (same provider draft; already-sent drafts are detected)", { messageStatus: "scheduled" });
  } else {
    await transition(svc, sd, "cancelled", { cancelledAt: now, resolutionRequired: false }, "owner cancelled an uncertain send (it may still have been sent)");
  }
}

/** Hook: anchor follow-ups to the actual recorded send time. */
async function afterRecordedSent(svc: Services, messageId: string) {
  const { scheduleNextFollowup } = await import("../outreach/sequences");
  await scheduleNextFollowup(svc, messageId).catch((e) => console.error("[followup]", errorSummary(e)));
  const [msg] = await svc.db.select().from(s.messages).where(eq(s.messages.id, messageId));
  if (msg?.companyId) await svc.db.update(s.opportunities).set({ stage: "applied_contacted", updatedAt: svc.clock.now() }).where(and(eq(s.opportunities.companyId, msg.companyId), eq(s.opportunities.stage, "prospect")));
}
