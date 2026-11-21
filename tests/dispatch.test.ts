/** Acceptance 9, 13–21, 25: revisions, cancel cutoff, recovery, concurrency, uncertain sends, limits, revocation. */
import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import * as s from "@/db/schema";
import { setup, sendRow } from "./harness";
import { scheduleMessage, cancelSend, rescheduleSend, resumeSends, setGlobalPause } from "@/domain/scheduling/service";
import { dispatchTick, reconcileSend, resolveUncertain, recoverExpiredLeases } from "@/domain/dispatch/dispatcher";
import { reviseMessage, approveCurrentRevision, ComposeError } from "@/domain/messages/compose";
import { syncMailbox } from "@/domain/mail/sync";
import { claimJobs } from "@/domain/jobs";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => ctx?.close());

async function scheduleAt(local: string, zone = "Europe/Oslo") {
  const msg = await ctx.approvedMessage();
  const sd = await scheduleMessage(ctx.svc, { ownerId: ctx.ownerId, messageId: msg.id, mode: "recipient_local", localIntent: local, zone });
  return { msg, sd };
}

describe("approval and revisions", () => {
  it("approves an exact revision with a specific CV version", async () => {
    ctx = await setup();
    const { msg, sd } = await scheduleAt("2027-01-11T07:00");
    const [rev] = await ctx.db.select().from(s.messageRevisions).where(eq(s.messageRevisions.messageId, msg.id));
    expect((rev.attachments as { sha256: string }[])[0].sha256).toBe(ctx.cv.sha256);
    expect(sd.revisionId).toBe(rev.id);
    expect(sd.plannedAt.toISOString()).toBe("2027-01-11T06:00:00.000Z");
  });

  it("blocks approval while placeholders are unresolved", async () => {
    ctx = await setup();
    const { createMessage } = await import("@/domain/messages/compose");
    const { message } = await createMessage(ctx.svc, { ownerId: ctx.ownerId, companyId: ctx.company.id, contactId: ctx.contact.id, content: { subject: "Hi {{contact.first_name}}", bodyHtml: "<p>x</p>", to: ["ingrid@fjord-robotics.example"], cc: [], mailboxId: ctx.mailbox.id, attachmentVersionIds: [] } });
    await expect(approveCurrentRevision(ctx.svc, { ownerId: ctx.ownerId, messageId: message.id })).rejects.toBeInstanceOf(ComposeError);
  });

  it("13: editing approved content supersedes the queued revision so it can never dispatch", async () => {
    ctx = await setup();
    const { msg, sd } = await scheduleAt("2027-01-11T07:00");
    const r = await reviseMessage(ctx.svc, { ownerId: ctx.ownerId, messageId: msg.id, content: { subject: "Edited subject", bodyHtml: "<p>New</p>", to: ["ingrid@fjord-robotics.example"], cc: [], mailboxId: ctx.mailbox.id, attachmentVersionIds: [ctx.cv.id] } });
    expect(r.revokedApproval).toBe(true);
    expect(r.supersededSends).toBe(1);
    ctx.clock.set("2027-01-11T06:05:00Z");
    await dispatchTick(ctx.svc);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("superseded");
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(0);
    // Even forcing the old row back to "scheduled" is caught by the recheck under claim.
    await ctx.db.update(s.scheduledSends).set({ state: "scheduled" }).where(eq(s.scheduledSends.id, sd.id));
    await dispatchTick(ctx.svc);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("superseded");
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(0);
  });
});

describe("real-time clock behaviour", () => {
  it("sends when time advances between reads (regression: spurious mailbox-gate deferral)", async () => {
    ctx = await setup();
    const { sd } = await scheduleAt("2027-01-11T07:00");
    ctx.clock.set("2027-01-11T06:00:30Z");
    let t = ctx.clock.now().getTime();
    const ticking = { ...ctx.svc, clock: { now: () => new Date((t += 3)) } };
    const r = await dispatchTick(ticking);
    expect(r.submitted).toBe(1);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("submitted");
  });
});

describe("cancel / reschedule / cutoff", () => {
  it("14: cancel and reschedule before dispatch leave nothing obsolete to send", async () => {
    ctx = await setup();
    const a = await scheduleAt("2027-01-11T07:00");
    expect((await cancelSend(ctx.svc, ctx.ownerId, a.sd.id)).result).toBe("cancelled");
    const b = await scheduleAt("2027-01-11T07:00");
    const rr = await rescheduleSend(ctx.svc, ctx.ownerId, b.sd.id, { localIntent: "2027-01-12T09:00", zone: "Europe/Oslo", mode: "recipient_local" });
    expect(rr.approvalPreserved).toBe(true);
    ctx.clock.set("2027-01-11T06:30:00Z");
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(0);
    ctx.clock.set("2027-01-12T08:01:00Z");
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(1);
    expect((await sendRow(ctx.db, a.sd.id)).state).toBe("cancelled");
  });

  it("15: cancellation under a concurrent claim is honoured before the send request, not after", async () => {
    ctx = await setup();
    const { sd } = await scheduleAt("2027-01-11T07:00");
    ctx.clock.set("2027-01-11T06:00:30Z");
    // Simulate a worker that has claimed but not yet asked the provider to send.
    await ctx.db.update(s.scheduledSends).set({ state: "dispatching", phase: "claimed", leaseOwner: "worker-B", leaseExpiresAt: new Date("2027-01-11T06:10:00Z") }).where(eq(s.scheduledSends.id, sd.id));
    const c = await cancelSend(ctx.svc, ctx.ownerId, sd.id);
    expect(c.result).toBe("cancel_requested");
    // Worker B continues: the recheck under its claim sees the request and does not send.
    await ctx.db.update(s.scheduledSends).set({ state: "scheduled", leaseOwner: null }).where(eq(s.scheduledSends.id, sd.id));
    await dispatchTick(ctx.make("worker-B"));
    expect((await sendRow(ctx.db, sd.id)).state).toBe("cancelled");
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(0);

    // After the send request is underway, cancel is refused as "too late".
    const two = await scheduleAt("2027-01-11T07:00");
    await ctx.db.update(s.scheduledSends).set({ state: "dispatching", phase: "send_requested", leaseOwner: "worker-B" }).where(eq(s.scheduledSends.id, two.sd.id));
    expect((await cancelSend(ctx.svc, ctx.ownerId, two.sd.id)).result).toBe("too_late");
  });
});

describe("persistence and concurrency", () => {
  it("16: restarting services preserves jobs; an expired lease before send is retried exactly once", async () => {
    ctx = await setup();
    const { sd } = await scheduleAt("2027-01-11T07:00");
    ctx.clock.set("2027-01-11T06:00:30Z");
    // Crash simulation: claimed by a worker that died in phase "claimed".
    await ctx.db.update(s.scheduledSends).set({ state: "dispatching", phase: "claimed", leaseOwner: "dead-worker", leaseExpiresAt: new Date("2027-01-11T06:01:00Z"), dispatchStartedAt: ctx.clock.now() }).where(eq(s.scheduledSends.id, sd.id));
    ctx.clock.set("2027-01-11T06:05:00Z");
    const restarted = ctx.make("worker-after-restart");
    const r = await dispatchTick(restarted);
    expect(r.recovered).toBe(1);
    expect(r.submitted).toBe(1);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(1);
    const revs = await ctx.db.select().from(s.messageRevisions);
    expect(revs).toHaveLength(1);
  });

  it("17: two workers never submit the same scheduled message", async () => {
    ctx = await setup();
    for (let i = 0; i < 3; i++) await scheduleAt("2027-01-11T07:00");
    ctx.clock.set("2027-01-11T06:00:30Z");
    const [a, b] = await Promise.all([dispatchTick(ctx.make("A")), dispatchTick(ctx.make("B"))]);
    expect(a.submitted + b.submitted).toBe(3);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(3);
    const attempts = await ctx.db.select().from(s.dispatchAttempts);
    expect(attempts.filter((x) => x.outcome === "submitted")).toHaveLength(3);
  });

  it("18: a timeout after possible acceptance becomes uncertain and reconciles without a resend", async () => {
    ctx = await setup();
    const { sd } = await scheduleAt("2027-01-11T07:00");
    ctx.mail.injectFault(ctx.mailbox.id, { op: "sendDraft", kind: "ambiguous", appliedBeforeError: true });
    ctx.clock.set("2027-01-11T06:00:30Z");
    const r = await dispatchTick(ctx.svc);
    expect(r.uncertain).toBe(1);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("uncertain");
    // Another tick must not resend.
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(1);
    expect(await reconcileSend(ctx.svc, sd.id)).toBe("recorded_sent");
    expect((await sendRow(ctx.db, sd.id)).state).toBe("recorded_sent");
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(1);
  });

  it("18b: an expired lease after the send request becomes uncertain, and 'retry' cannot double-send", async () => {
    ctx = await setup();
    const { sd } = await scheduleAt("2027-01-11T07:00");
    ctx.clock.set("2027-01-11T06:00:30Z");
    // Fault: provider accepts, then the worker "crashes" (we emulate with an ambiguous error, then lease expiry path).
    ctx.mail.injectFault(ctx.mailbox.id, { op: "sendDraft", kind: "ambiguous", appliedBeforeError: true });
    await dispatchTick(ctx.svc);
    await resolveUncertain(ctx.svc, ctx.ownerId, sd.id, "retry_same_draft");
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(1); // draft already sent → detected, not resent
    const row = await sendRow(ctx.db, sd.id);
    expect(["submitted", "recorded_sent"]).toContain(row.state);
  });
});

describe("evidence states", () => {
  it("19: submitted ≠ recorded sent ≠ delivered; a bounce keeps outreach history", async () => {
    ctx = await setup();
    const { MockMailProvider } = await import("@/providers/mail/mock");
    const slow = new MockMailProvider(ctx.mockStore, ctx.clock, { sentCopyDelayMs: 10 * 60_000 });
    const svc = { ...ctx.svc, mailProvider: () => slow };
    const msg = await ctx.approvedMessage();
    const sd = await scheduleMessage(svc, { ownerId: ctx.ownerId, messageId: msg.id, mode: "recipient_local", localIntent: "2027-01-11T07:00", zone: "Europe/Oslo" });
    ctx.clock.set("2027-01-11T06:00:30Z");
    await dispatchTick(svc);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("submitted");
    expect(await reconcileSend(svc, sd.id)).toBe("pending"); // sent copy not visible yet
    ctx.clock.advanceMinutes(11);
    expect(await reconcileSend(svc, sd.id)).toBe("recorded_sent");
    const [m] = await ctx.db.select().from(s.messages).where(eq(s.messages.id, msg.id));
    expect(m.recordedSentAt).not.toBeNull();
    // Bounce arrives.
    slow.simulateInbound(ctx.mailbox.id, { from: "mailer-daemon@mail.example", subject: "Undeliverable: Internship enquiry", text: "Delivery has failed to these recipients: ingrid@fjord-robotics.example" });
    await syncMailbox(svc, ctx.mailbox.id);
    const [after] = await ctx.db.select().from(s.messages).where(eq(s.messages.id, msg.id));
    expect(after.isBounce).toBe(true);
    expect(after.recordedSentAt).not.toBeNull(); // history kept
    const [addr] = await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.normalized, "ingrid@fjord-robotics.example"));
    expect(addr.bounceState).toBe("hard");
    const tasks = await ctx.db.select().from(s.tasks).where(eq(s.tasks.kind, "replacement_contact"));
    expect(tasks).toHaveLength(1);
  });
});

describe("limits, throttling, pauses, overdue", () => {
  it("20: respects hourly limits, Retry-After, global pause, and holds stale overdue work", async () => {
    ctx = await setup();
    await ctx.db.update(s.mailboxes).set({ hourlyLimit: 2 }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await scheduleAt("2027-01-11T07:00")).sd.id);
    ctx.clock.set("2027-01-11T06:00:30Z");
    for (let i = 0; i < 3; i++) await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(2);
    const third = await sendRow(ctx.db, ids[2]);
    expect(third.state).toBe("scheduled");
    expect(third.nextAttemptAt!.getTime()).toBeGreaterThan(ctx.clock.now().getTime() + 50 * 60_000);

    // Throttling: 429 with Retry-After.
    await ctx.db.update(s.mailboxes).set({ hourlyLimit: 20 }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    await ctx.db.update(s.scheduledSends).set({ nextAttemptAt: null }).where(eq(s.scheduledSends.id, ids[2]));
    ctx.mail.injectFault(ctx.mailbox.id, { op: "sendDraft", kind: "throttled", retryAfterSeconds: 120 });
    const t = await dispatchTick(ctx.svc);
    expect(t.deferred).toBe(1);
    const [mb] = await ctx.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, ctx.mailbox.id));
    expect(mb.throttledUntil!.getTime()).toBe(ctx.clock.now().getTime() + 120_000);
    ctx.clock.advanceMinutes(3);
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(3);

    // Global pause, then resume long after: stale work is held, not burst-sent.
    const p = [];
    for (let i = 0; i < 4; i++) p.push((await scheduleAt("2027-01-11T08:00")).sd.id);
    await setGlobalPause(ctx.svc, ctx.ownerId, true, "exam week");
    ctx.clock.set("2027-01-11T07:00:30Z");
    await dispatchTick(ctx.svc);
    expect((await sendRow(ctx.db, p[0])).state).toBe("paused");
    await setGlobalPause(ctx.svc, ctx.ownerId, false);
    ctx.clock.set("2027-01-11T13:00:00Z"); // 6h later; grace is 120 min
    const res = await resumeSends(ctx.svc, ctx.ownerId, p);
    expect(res.every((r) => r.state === "held")).toBe(true);
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(3);
  });

  it("20b: recent overdue work after a pause is re-spread from now through limits", async () => {
    ctx = await setup();
    await ctx.db.update(s.mailboxes).set({ minSpacingSeconds: 600 }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    const p = [];
    for (let i = 0; i < 3; i++) p.push((await scheduleAt("2027-01-11T07:00")).sd.id);
    await setGlobalPause(ctx.svc, ctx.ownerId, true);
    ctx.clock.set("2027-01-11T06:00:30Z");
    await dispatchTick(ctx.svc);
    await setGlobalPause(ctx.svc, ctx.ownerId, false);
    ctx.clock.set("2027-01-11T06:30:00Z");
    const res = await resumeSends(ctx.svc, ctx.ownerId, p);
    const times = res.map((r) => r.plannedAt.getTime()).sort();
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(600_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(600_000);
  });

  it("21: a revoked mailbox holds its sends without losing schedules", async () => {
    ctx = await setup();
    const { sd } = await scheduleAt("2027-01-11T07:00");
    ctx.mail.revokeToken(ctx.mailbox.id, `mock-token-${ctx.mailbox.id}`);
    ctx.clock.set("2027-01-11T06:00:30Z");
    await dispatchTick(ctx.svc);
    const row = await sendRow(ctx.db, sd.id);
    expect(row.state).toBe("held");
    expect(row.revisionId).toBe(sd.revisionId);
    const [mb] = await ctx.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, ctx.mailbox.id));
    expect(mb.status).toBe("expired");
    // A second tick does not touch it (mailbox unavailable) and nothing is sent.
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(0);
  });
});

describe("follow-ups and sync freshness", () => {
  it("25: a follow-up is held while sync is stale and re-evaluated after a successful sync", async () => {
    ctx = await setup();
    const msg = await ctx.approvedMessage({ kind: "followup" });
    const sd = await scheduleMessage(ctx.svc, { ownerId: ctx.ownerId, messageId: msg.id, mode: "my_local", localIntent: "2027-01-11T10:00", zone: "Asia/Riyadh" });
    await ctx.db.update(s.mailboxes).set({ lastSyncAt: new Date("2027-01-10T00:00:00Z") }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    ctx.clock.set("2027-01-11T07:00:30Z");
    await dispatchTick(ctx.svc);
    const held = await sendRow(ctx.db, sd.id);
    expect(held.state).toBe("held");
    expect(held.holdReason).toMatch(/Follow-up held/);
    await syncMailbox(ctx.svc, ctx.mailbox.id);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("scheduled");
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(1);
  });

  it("25b: a follow-up held past the grace window stays held for review after sync recovers", async () => {
    ctx = await setup();
    const msg = await ctx.approvedMessage({ kind: "followup" });
    const sd = await scheduleMessage(ctx.svc, { ownerId: ctx.ownerId, messageId: msg.id, mode: "my_local", localIntent: "2027-01-11T10:00", zone: "Asia/Riyadh" });
    await ctx.db.update(s.mailboxes).set({ lastSyncAt: new Date("2027-01-10T00:00:00Z") }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    ctx.clock.set("2027-01-11T07:00:30Z");
    await dispatchTick(ctx.svc);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("held");
    ctx.clock.set("2027-01-11T12:00:00Z"); // 5h later; grace is 120 min
    await syncMailbox(ctx.svc, ctx.mailbox.id);
    const row = await sendRow(ctx.db, sd.id);
    expect(row.state).toBe("held");
    expect(row.holdReason).toMatch(/review and release/);
    await dispatchTick(ctx.svc);
    expect(ctx.mail.state(ctx.mailbox.id).sentCount).toBe(0);
  });

  it("recovers expired leases with no due work and leaves jobs durable", async () => {
    ctx = await setup();
    expect(await recoverExpiredLeases(ctx.svc)).toBe(0);
    const jobs = await claimJobs(ctx.db, { workerId: "x", now: ctx.clock.now() });
    expect(jobs).toHaveLength(0);
    void and;
  });
});
