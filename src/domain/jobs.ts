/**
 * Durable PostgreSQL job queue (outbox). Claims are single-statement
 * compare-and-set updates with a lease, so two workers never run the same job
 * at once and an expired lease is recovered after a crash.
 *
 * Why not pg-boss: dispatch needs its own row-level state machine on
 * scheduled_sends (phases, cancel-under-claim, reconciliation) that a generic
 * queue would duplicate; this table covers the auxiliary jobs and also runs on
 * in-process PGlite for tests. See docs/ARCHITECTURE.md.
 */
import { and, eq, inArray, lte, or, sql, isNull, lt } from "drizzle-orm";
import * as s from "@/db/schema";
import type { DbOrTx } from "@/db/client";
import { errorSummary } from "@/lib/redact";

export async function enqueueJob(db: DbOrTx, j: { ownerId?: string | null; kind: string; payload?: Record<string, unknown>; runAt?: Date; dedupeKey?: string; maxAttempts?: number }) {
  const rows = await db.insert(s.jobs).values({
    ownerId: j.ownerId ?? null,
    kind: j.kind,
    payload: j.payload ?? {},
    runAt: j.runAt ?? new Date(),
    dedupeKey: j.dedupeKey ?? null,
    maxAttempts: j.maxAttempts ?? 5,
  }).onConflictDoNothing().returning();
  return rows[0] ?? null;
}

export async function claimJobs(db: DbOrTx, opts: { workerId: string; now: Date; kinds?: string[]; limit?: number; leaseMs?: number }) {
  const lease = new Date(opts.now.getTime() + (opts.leaseMs ?? 120_000));
  const due = await db.select({ id: s.jobs.id }).from(s.jobs).where(and(
    opts.kinds ? inArray(s.jobs.kind, opts.kinds) : sql`true`,
    lte(s.jobs.runAt, opts.now),
    or(eq(s.jobs.status, "queued"), and(eq(s.jobs.status, "running"), lt(s.jobs.leaseExpiresAt, opts.now))),
  )).orderBy(s.jobs.runAt).limit(opts.limit ?? 10);
  const claimed: (typeof s.jobs.$inferSelect)[] = [];
  for (const { id } of due) {
    const [row] = await db.update(s.jobs).set({ status: "running", leaseOwner: opts.workerId, leaseExpiresAt: lease, attempts: sql`${s.jobs.attempts} + 1`, // coalescing keys (":pending") are released on claim so new work can queue
      dedupeKey: sql`CASE WHEN ${s.jobs.dedupeKey} LIKE '%:pending' THEN NULL ELSE ${s.jobs.dedupeKey} END` })
      .where(and(eq(s.jobs.id, id), or(eq(s.jobs.status, "queued"), and(eq(s.jobs.status, "running"), lt(s.jobs.leaseExpiresAt, opts.now)))))
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function completeJob(db: DbOrTx, id: string, workerId: string, now: Date) {
  await db.update(s.jobs).set({ status: "done", finishedAt: now, leaseOwner: null, leaseExpiresAt: null }).where(and(eq(s.jobs.id, id), eq(s.jobs.leaseOwner, workerId)));
}

/** Bounded exponential backoff; terminal "failed" after maxAttempts. */
export async function failJob(db: DbOrTx, job: typeof s.jobs.$inferSelect, err: unknown, now: Date, retryAfterMs?: number) {
  const terminal = job.attempts >= job.maxAttempts;
  const backoff = retryAfterMs ?? Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, job.attempts - 1));
  await db.update(s.jobs).set({
    status: terminal ? "failed" : "queued",
    runAt: new Date(now.getTime() + backoff),
    lastError: errorSummary(err),
    leaseOwner: null,
    leaseExpiresAt: null,
    finishedAt: terminal ? now : null,
  }).where(eq(s.jobs.id, job.id));
}

export async function reschedulePeriodic(db: DbOrTx, kind: string, dedupeKey: string, runAt: Date, payload: Record<string, unknown> = {}, ownerId?: string) {
  // Re-arm a periodic job by dedupe key (done → queued again).
  const [existing] = await db.select().from(s.jobs).where(eq(s.jobs.dedupeKey, dedupeKey));
  if (!existing) return enqueueJob(db, { kind, dedupeKey, runAt, payload, ownerId });
  if (existing.status === "running") return existing;
  await db.update(s.jobs).set({ status: "queued", runAt, attempts: 0, lastError: null, finishedAt: null, payload }).where(and(eq(s.jobs.id, existing.id), or(isNull(s.jobs.leaseOwner), sql`true`)));
  return existing;
}
