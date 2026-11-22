/**
 * App-owned scheduling queue. Graph has no general delayed-send endpoint we
 * rely on; the durable scheduled_sends row IS the queue entry (written in the
 * same transaction as the message status change — transactional outbox
 * equivalent). Workers read due work from the database only.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import * as s from "@/db/schema";
import type { DbOrTx } from "@/db/client";
import { suggestTimezone } from "../normalize";
import { currentApproval, ComposeError } from "../messages/compose";
import { logTransition, CANCELLABLE, type SendState } from "../dispatch/states";
import type { Services } from "../services";
import {
  planBatch, resolveLocalTime, nextEligibleInstant, toLocalIntent, classifyOverdue, nextWeekdayAt,
  type DstResolution, type ScheduleMode, type SendingWindow, type BatchAssignment, type ResolveOption,
} from "./time";

export class ScheduleError extends Error {
  constructor(message: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

async function settingsFor(db: DbOrTx, ownerId: string) {
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, ownerId));
  if (!st) throw new ScheduleError("Owner settings missing.");
  return st;
}

/** Suggest the recipient business timezone from the company's primary office (editable). */
export async function recipientZoneSuggestion(db: DbOrTx, companyId: string | null) {
  if (!companyId) return { zone: null, confidence: "none" as const, candidates: [] as string[], explanation: "No company linked." };
  const [loc] = await db.select().from(s.companyLocations).where(and(eq(s.companyLocations.companyId, companyId), eq(s.companyLocations.isPrimary, true)));
  if (loc?.timezone) return { zone: loc.timezone, confidence: loc.geocodeStatus === "manual" ? ("city" as const) : ("country" as const), candidates: [loc.timezone], explanation: `From company office (${loc.label ?? loc.country ?? "location"}). Editable.` };
  const [co] = await db.select().from(s.companies).where(eq(s.companies.id, companyId));
  return suggestTimezone(co?.country, co?.city);
}

export interface ScheduleRequest {
  ownerId: string;
  messageId: string;
  mode: ScheduleMode;
  localIntent: string;      // "YYYY-MM-DDTHH:mm" in `zone`
  zone: string;             // recipient zone (recipient_local) or owner zone (my_local)
  dstResolution?: DstResolution;
  respectWindow?: boolean;  // move into sending window (default true)
  actor?: string;
}

export async function scheduleMessage(svc: Services, req: ScheduleRequest) {
  const resolved = resolveLocalTime(req.localIntent, req.zone, req.dstResolution ?? "none");
  if (resolved.status !== "ok") throw new ScheduleError(resolved.explanation, { status: resolved.status, options: "options" in resolved ? resolved.options : [] });
  return svc.db.transaction(async (tx) => {
    const ca = await currentApproval(tx, req.messageId);
    if (!ca || ca.message.ownerId !== req.ownerId) throw new ScheduleError("Approve the current revision before scheduling.");
    const active = await tx.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.messageId, req.messageId), inArray(s.scheduledSends.state, ["scheduled", "held", "paused", "dispatching", "submitted", "uncertain"])));
    if (active.length) throw new ScheduleError(`Message already has a ${active[0].state} send. Reschedule or cancel it instead.`);
    const st = await settingsFor(tx, req.ownerId);
    let planned = resolved.utc;
    let windowNote: string | null = null;
    if (req.respectWindow !== false) {
      const adj = nextEligibleInstant(planned, req.zone, st.sendingWindow as SendingWindow);
      if (adj.getTime() !== planned.getTime()) windowNote = `Moved into sending window (${toLocalIntent(adj, req.zone)} ${req.zone}).`;
      planned = adj;
    }
    const [sd] = await tx.insert(s.scheduledSends).values({
      ownerId: req.ownerId,
      messageId: req.messageId,
      revisionId: ca.revision.id,
      approvalId: ca.approval.id,
      mailboxId: ca.revision.mailboxId!,
      campaignId: ca.message.campaignId,
      state: "scheduled",
      plannedAt: planned,
      intentLocal: req.localIntent,
      intentZone: req.zone,
      mode: req.mode,
      dstResolution: req.dstResolution ?? "none",
      isDemo: ca.message.isDemo,
      // App clock, not the DB clock: eligibility compares this with provider timestamps (and simulated demo time).
      createdAt: svc.clock.now(),
    }).returning();
    await tx.update(s.messages).set({ status: "scheduled", updatedAt: svc.clock.now() }).where(eq(s.messages.id, req.messageId));
    await logTransition(tx, { ownerId: req.ownerId, scheduledSendId: sd.id, messageId: req.messageId, from: null, to: "scheduled", actor: req.actor ?? "user", reason: windowNote ?? `planned ${req.mode} ${req.localIntent} ${req.zone}`, at: svc.clock.now() });
    return sd;
  });
}

// ───────────────────────── Batch scheduling ─────────────────────────
export interface BatchPreviewItem {
  messageId: string;
  companyName: string | null;
  to: string[];
  mailboxId: string | null;
  zone: string | null;
  zoneExplanation: string;
  localIntent: string | null;
  desiredUtc: Date | null;
  plannedUtc: Date | null;
  shiftedMinutes: number;
  reasons: string[];
  issues: string[];
  dstOptions?: ResolveOption[];
  excluded: boolean;
}

export interface BatchRequest {
  ownerId: string;
  messageIds: string[];
  mode: ScheduleMode;
  /** Either an explicit local date ("2027-01-11") or next weekday (1=Mon). */
  localDate?: string;
  nextWeekday?: number;
  time: string;                       // "07:00"
  zoneOverrides?: Record<string, string>;
  dstResolutions?: Record<string, DstResolution>;
  excluded?: string[];
}

export async function previewBatch(svc: Services, req: BatchRequest): Promise<BatchPreviewItem[]> {
  const db = svc.db;
  const st = await settingsFor(db, req.ownerId);
  const myZone = st.displayTimezone;
  const items: BatchPreviewItem[] = [];
  for (const id of req.messageIds) {
    const ca = await currentApproval(db, id);
    const [msg] = await db.select().from(s.messages).where(and(eq(s.messages.id, id), eq(s.messages.ownerId, req.ownerId)));
    const [co] = msg?.companyId ? await db.select().from(s.companies).where(eq(s.companies.id, msg.companyId)) : [];
    const item: BatchPreviewItem = { messageId: id, companyName: co?.name ?? null, to: (msg?.toAddresses as string[]) ?? [], mailboxId: ca?.revision.mailboxId ?? msg?.mailboxId ?? null, zone: null, zoneExplanation: "", localIntent: null, desiredUtc: null, plannedUtc: null, shiftedMinutes: 0, reasons: [], issues: [], excluded: req.excluded?.includes(id) ?? false };
    items.push(item);
    if (!msg) {
      item.issues.push("Message not found.");
      continue;
    }
    if (!ca) item.issues.push("Current revision is not approved.");
    let zone: string | null = req.zoneOverrides?.[id] ?? null;
    if (req.mode === "my_local") {
      zone = myZone;
      item.zoneExplanation = `Your display timezone (${myZone}).`;
    } else if (!zone) {
      const sug = await recipientZoneSuggestion(db, msg.companyId);
      zone = sug.zone;
      item.zoneExplanation = sug.explanation;
      if (!zone) item.issues.push(`Recipient timezone unknown: ${sug.explanation}${sug.candidates.length ? ` Options: ${sug.candidates.join(", ")}.` : ""}`);
    } else item.zoneExplanation = "Timezone chosen manually.";
    item.zone = zone;
    if (!zone) continue;
    const localDate = req.localDate ?? (req.nextWeekday ? nextWeekdayDate(svc.clock.now(), zone, req.nextWeekday, req.time) : null);
    if (!localDate) {
      item.issues.push("Choose a date or weekday.");
      continue;
    }
    item.localIntent = `${localDate}T${req.time}`;
    const r = resolveLocalTime(item.localIntent, zone, req.dstResolutions?.[id] ?? "none");
    if (r.status === "ok") item.desiredUtc = r.utc;
    else {
      item.issues.push(r.explanation);
      if ("options" in r) item.dstOptions = r.options;
    }
    if (item.desiredUtc && item.desiredUtc < svc.clock.now()) item.issues.push("That time is in the past.");
  }

  // Spread per mailbox through limits, including already-planned sends.
  const byMailbox = new Map<string, BatchPreviewItem[]>();
  for (const it of items) if (!it.issues.length && !it.excluded && it.mailboxId && it.desiredUtc) byMailbox.set(it.mailboxId, [...(byMailbox.get(it.mailboxId) ?? []), it]);
  for (const [mailboxId, group] of byMailbox) {
    const [mb] = await db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mailboxId));
    if (!mb) {
      group.forEach((g) => g.issues.push("Mailbox not found."));
      continue;
    }
    if (mb.status !== "connected") group.forEach((g) => g.reasons.push(`Mailbox is ${mb.status}: sends will be held until reconnected.`));
    const existing = await db.select({ t: s.scheduledSends.plannedAt }).from(s.scheduledSends).where(and(eq(s.scheduledSends.mailboxId, mailboxId), inArray(s.scheduledSends.state, ["scheduled", "paused", "held"])));
    const plan: BatchAssignment[] = planBatch(
      group.map((g) => ({ id: g.messageId, desiredUtc: g.desiredUtc!, zone: g.zone! })),
      { dailyLimit: mb.dailyLimit, hourlyLimit: mb.hourlyLimit, minSpacingSeconds: mb.minSpacingSeconds },
      st.sendingWindow as SendingWindow,
      myZone,
      existing.map((e) => e.t),
    );
    for (const a of plan) {
      const it = group.find((g) => g.messageId === a.id)!;
      it.plannedUtc = a.plannedUtc;
      it.shiftedMinutes = a.shiftedMinutes;
      it.reasons.push(...a.reasons);
    }
  }
  return items;
}

function nextWeekdayDate(from: Date, zone: string, weekday: number, time: string) {
  return nextWeekdayAt(from, zone, weekday, time).slice(0, 10);
}

/** Commit a reviewed batch exactly as previewed (planned times included). */
export async function commitBatch(svc: Services, ownerId: string, preview: BatchPreviewItem[], mode: ScheduleMode) {
  const created: string[] = [];
  const skipped: { messageId: string; reason: string }[] = [];
  for (const it of preview) {
    if (it.excluded || it.issues.length || !it.plannedUtc || !it.zone || !it.localIntent) {
      skipped.push({ messageId: it.messageId, reason: it.excluded ? "excluded" : it.issues.join(" ") || "not planned" });
      continue;
    }
    await svc.db.transaction(async (tx) => {
      const ca = await currentApproval(tx, it.messageId);
      if (!ca) throw new ComposeError("Approval changed since preview; re-run the preview.");
      const [sd] = await tx.insert(s.scheduledSends).values({
        ownerId, messageId: it.messageId, revisionId: ca.revision.id, approvalId: ca.approval.id, mailboxId: ca.revision.mailboxId!, campaignId: ca.message.campaignId,
        state: "scheduled", plannedAt: it.plannedUtc!, intentLocal: it.localIntent!, intentZone: it.zone!, mode, dstResolution: "none", isDemo: ca.message.isDemo, createdAt: svc.clock.now(),
      }).returning();
      await tx.update(s.messages).set({ status: "scheduled" }).where(eq(s.messages.id, it.messageId));
      await logTransition(tx, { ownerId, scheduledSendId: sd.id, messageId: it.messageId, from: null, to: "scheduled", actor: "user", reason: `batch: ${it.localIntent} ${it.zone}${it.shiftedMinutes ? ` (+${it.shiftedMinutes} min: ${it.reasons.join(", ")})` : ""}`, at: svc.clock.now() });
      created.push(sd.id);
    });
  }
  return { created, skipped };
}

// ───────────────────────── Queue controls ─────────────────────────
async function casState(tx: DbOrTx, id: string, from: SendState[], set: Partial<typeof s.scheduledSends.$inferInsert>) {
  const [cur] = await tx.select().from(s.scheduledSends).where(eq(s.scheduledSends.id, id));
  if (!cur) throw new ScheduleError("Scheduled send not found.");
  if (!from.includes(cur.state as SendState)) return { cur, updated: null };
  const [upd] = await tx.update(s.scheduledSends).set({ ...set, version: cur.version + 1, updatedAt: new Date() }).where(and(eq(s.scheduledSends.id, id), eq(s.scheduledSends.version, cur.version), eq(s.scheduledSends.state, cur.state))).returning();
  return { cur, updated: upd ?? null };
}

export type CancelOutcome =
  | { result: "cancelled" }
  | { result: "cancel_requested"; explanation: string }
  | { result: "too_late"; state: string; explanation: string };

/**
 * Cancellation cutoff (documented in the UI):
 *  - scheduled/held/paused: cancelled atomically; it will not be sent.
 *  - dispatching before the provider request: a cancel request is recorded and
 *    honoured by the worker under its claim (it rechecks right before sending).
 *  - once the send request is underway or after submission: too late; Outlook
 *    has no reliable recall and this app does not claim one.
 */
export async function cancelSend(svc: Services, ownerId: string, id: string, reason = "cancelled by user"): Promise<CancelOutcome> {
  return svc.db.transaction(async (tx) => {
    const { cur, updated } = await casState(tx, id, CANCELLABLE, { state: "cancelled", cancelledAt: svc.clock.now(), holdReason: reason });
    if (cur.ownerId !== ownerId) throw new ScheduleError("Not found.");
    if (updated) {
      await tx.update(s.messages).set({ status: "cancelled" }).where(eq(s.messages.id, cur.messageId));
      await logTransition(tx, { ownerId, scheduledSendId: id, messageId: cur.messageId, from: cur.state, to: "cancelled", actor: "user", reason, at: svc.clock.now() });
      return { result: "cancelled" as const };
    }
    if (cur.state === "dispatching" && cur.phase !== "send_requested") {
      const r = await tx.update(s.scheduledSends).set({ cancelRequestedAt: svc.clock.now() }).where(and(eq(s.scheduledSends.id, id), eq(s.scheduledSends.state, "dispatching"), sql`${s.scheduledSends.phase} <> 'send_requested'`)).returning();
      if (r.length) {
        await logTransition(tx, { ownerId, scheduledSendId: id, messageId: cur.messageId, from: cur.state, to: "dispatching", actor: "user", reason: "cancel requested during dispatch (best effort, before provider request)", at: svc.clock.now() });
        return { result: "cancel_requested" as const, explanation: "A worker had already claimed this send. The cancel will be honoured if the worker has not yet asked Outlook to send." };
      }
    }
    return { result: "too_late" as const, state: cur.state, explanation: `This message is ${cur.state.replace(/_/g, " ")}. The provider request is already underway or finished; it cannot be recalled reliably.` };
  });
}

export async function rescheduleSend(svc: Services, ownerId: string, id: string, req: { localIntent: string; zone: string; mode: ScheduleMode; dstResolution?: DstResolution }) {
  const r = resolveLocalTime(req.localIntent, req.zone, req.dstResolution ?? "none");
  if (r.status !== "ok") throw new ScheduleError(r.explanation, { status: r.status, options: "options" in r ? r.options : [] });
  return svc.db.transaction(async (tx) => {
    const st = await settingsFor(tx, ownerId);
    const [cur] = await tx.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.id, id), eq(s.scheduledSends.ownerId, ownerId)));
    if (!cur) throw new ScheduleError("Not found.");
    if (!["scheduled", "held", "paused", "failed"].includes(cur.state)) throw new ScheduleError(`Cannot reschedule a ${cur.state} send.`);
    const ca = await currentApproval(tx, cur.messageId);
    const approvalStillValid = !!ca && ca.revision.id === cur.revisionId && st.keepApprovalOnReschedule;
    const planned = nextEligibleInstant(r.utc, req.zone, st.sendingWindow as SendingWindow);
    if (!approvalStillValid) {
      // Old row is superseded; a fresh approval + schedule is required.
      const { updated } = await casState(tx, id, [cur.state as SendState], { state: "superseded", holdReason: "Rescheduled; content or policy requires re-approval" });
      if (!updated) throw new ScheduleError("The send changed state concurrently; reload.");
      await tx.update(s.messages).set({ status: "awaiting_approval" }).where(eq(s.messages.id, cur.messageId));
      await logTransition(tx, { ownerId, scheduledSendId: id, messageId: cur.messageId, from: cur.state, to: "superseded", actor: "user", reason: "reschedule requires re-approval", at: svc.clock.now() });
      return { approvalPreserved: false as const, sendId: null };
    }
    const { updated } = await casState(tx, id, [cur.state as SendState], { state: "scheduled", plannedAt: planned, intentLocal: req.localIntent, intentZone: req.zone, mode: req.mode, dstResolution: req.dstResolution ?? "none", holdReason: null, nextAttemptAt: null, lastError: null });
    if (!updated) throw new ScheduleError("The send changed state concurrently; reload.");
    await tx.update(s.messages).set({ status: "scheduled" }).where(eq(s.messages.id, cur.messageId));
    await logTransition(tx, { ownerId, scheduledSendId: id, messageId: cur.messageId, from: cur.state, to: "scheduled", actor: "user", reason: `rescheduled to ${req.localIntent} ${req.zone} (approval kept: content unchanged)`, at: svc.clock.now() });
    return { approvalPreserved: true as const, sendId: id };
  });
}

export async function pauseSend(svc: Services, ownerId: string, id: string, reason = "paused by user") {
  return svc.db.transaction(async (tx) => {
    const { cur, updated } = await casState(tx, id, ["scheduled", "held"], { state: "paused", holdReason: reason });
    if (cur.ownerId !== ownerId) throw new ScheduleError("Not found.");
    if (!updated) throw new ScheduleError(`Cannot pause a ${cur.state} send.`);
    await tx.update(s.messages).set({ status: "paused" }).where(eq(s.messages.id, cur.messageId));
    await logTransition(tx, { ownerId, scheduledSendId: id, messageId: cur.messageId, from: cur.state, to: "paused", actor: "user", reason, at: svc.clock.now() });
    return updated;
  });
}

/**
 * Resume paused/held sends. Items whose planned time has passed are re-planned
 * from now through mailbox limits (recent) or kept held for review (stale),
 * so resuming never releases a burst.
 */
export async function resumeSends(svc: Services, ownerId: string, ids: string[], opts: { releaseStale?: boolean } = {}) {
  const st = await settingsFor(svc.db, ownerId);
  const now = svc.clock.now();
  const rows = await svc.db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.ownerId, ownerId), inArray(s.scheduledSends.id, ids), inArray(s.scheduledSends.state, ["paused", "held"])));
  const result: { id: string; state: string; plannedAt: Date; note: string }[] = [];
  const byMailbox = new Map<string, typeof rows>();
  for (const r of rows) byMailbox.set(r.mailboxId, [...(byMailbox.get(r.mailboxId) ?? []), r]);
  for (const [mailboxId, group] of byMailbox) {
    const [mb] = await svc.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mailboxId));
    const future = group.filter((g) => g.plannedAt > now);
    const overdue = group.filter((g) => g.plannedAt <= now);
    // An explicit "release" after review re-plans stale items from now as well (still spread through limits).
    const stale = opts.releaseStale ? [] : overdue.filter((g) => classifyOverdue(g.plannedAt, now, st.missedSendGraceMinutes) === "stale_overdue");
    const recent = overdue.filter((g) => !stale.includes(g));
    const existing = await svc.db.select({ t: s.scheduledSends.plannedAt }).from(s.scheduledSends).where(and(eq(s.scheduledSends.mailboxId, mailboxId), eq(s.scheduledSends.state, "scheduled")));
    const replanned = planBatch(recent.map((g) => ({ id: g.id, desiredUtc: now, zone: g.intentZone })), { dailyLimit: mb.dailyLimit, hourlyLimit: mb.hourlyLimit, minSpacingSeconds: mb.minSpacingSeconds }, st.sendingWindow as SendingWindow, st.displayTimezone, [...existing.map((e) => e.t), ...future.map((f) => f.plannedAt)]);
    for (const g of group) {
      let state = "scheduled";
      let plannedAt = g.plannedAt;
      let note = "resumed";
      if (stale.includes(g)) {
        state = "held";
        note = `planned time passed more than ${st.missedSendGraceMinutes} min ago — review before sending`;
      } else if (recent.includes(g)) {
        plannedAt = replanned.find((p) => p.id === g.id)!.plannedUtc;
        note = "planned time passed during pause; re-spread from now within limits";
      }
      await svc.db.transaction(async (tx) => {
        const { updated } = await casState(tx, g.id, [g.state as SendState], { state, plannedAt, holdReason: state === "held" ? note : null, nextAttemptAt: null });
        if (!updated) return;
        await tx.update(s.messages).set({ status: state }).where(eq(s.messages.id, g.messageId));
        await logTransition(tx, { ownerId, scheduledSendId: g.id, messageId: g.messageId, from: g.state, to: state, actor: "user", reason: note, at: now });
        result.push({ id: g.id, state, plannedAt, note });
      });
    }
  }
  return result;
}

export async function setGlobalPause(svc: Services, ownerId: string, paused: boolean, reason?: string) {
  await svc.db.update(s.settings).set({ globalPause: paused, globalPauseReason: paused ? reason ?? "Paused by owner" : null, globalPausedAt: paused ? svc.clock.now() : null }).where(eq(s.settings.ownerId, ownerId));
}

export async function setCampaignPause(svc: Services, ownerId: string, campaignId: string, paused: boolean, reason?: string) {
  await svc.db.update(s.campaigns).set({ paused, pausedReason: paused ? reason ?? "Paused" : null, pausedAt: paused ? svc.clock.now() : null }).where(and(eq(s.campaigns.id, campaignId), eq(s.campaigns.ownerId, ownerId)));
}

export async function queueCounts(db: DbOrTx, ownerId: string, now: Date, zone: string) {
  const startToday = DateTime.fromJSDate(now, { zone }).startOf("day");
  const rows = await db.select({ state: s.scheduledSends.state, plannedAt: s.scheduledSends.plannedAt }).from(s.scheduledSends).where(and(eq(s.scheduledSends.ownerId, ownerId), isNull(s.scheduledSends.cancelledAt)));
  const inRange = (d: Date, a: DateTime, b: DateTime) => d >= a.toJSDate() && d < b.toJSDate();
  const sched = rows.filter((r) => r.state === "scheduled");
  return {
    today: sched.filter((r) => inRange(r.plannedAt, startToday, startToday.plus({ days: 1 }))).length,
    tomorrow: sched.filter((r) => inRange(r.plannedAt, startToday.plus({ days: 1 }), startToday.plus({ days: 2 }))).length,
    thisWeek: sched.filter((r) => inRange(r.plannedAt, startToday.startOf("week"), startToday.startOf("week").plus({ weeks: 1 }))).length,
    overdue: sched.filter((r) => r.plannedAt < now).length,
    paused: rows.filter((r) => r.state === "paused").length,
    held: rows.filter((r) => r.state === "held").length,
    failed: rows.filter((r) => r.state === "failed").length,
    uncertain: rows.filter((r) => r.state === "uncertain").length,
  };
}
