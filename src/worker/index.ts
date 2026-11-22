/**
 * Persistent worker. Must run continuously for scheduled sends, sync,
 * reconciliation, discovery batches and geocoding. A local install performs
 * background work only while this process is running; a cloud deployment
 * keeps it running when your PC is off (see docs/DEPLOYMENT.md).
 *
 * All due work is read from PostgreSQL, so restarts lose nothing.
 */
import "./env";
import { and, eq, lt } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import * as s from "@/db/schema";
import { getServices } from "@/server/runtime";
import { dispatchTick, reconcileSend } from "@/domain/dispatch/dispatcher";
import { claimJobs, completeJob, failJob, reschedulePeriodic } from "@/domain/jobs";
import { syncMailbox } from "@/domain/mail/sync";
import { ensureSubscriptions, renewSubscriptions, webhooksEnabled } from "@/domain/mail/subscriptions";
import { geocodePending, geocoderConfig } from "@/domain/geo/geocode";
import { runDiscoveryStep } from "@/domain/discovery/service";
import { errorSummary } from "@/lib/redact";

// Empty values in .env (e.g. "SYNC_POLL_MINUTES=") mean "use the default", never 0.
const TICK_MS = Number(process.env.WORKER_TICK_MS) || 5000;
const POLL_MINUTES = Number(process.env.SYNC_POLL_MINUTES) || (webhooksEnabled() ? 30 : 5);
let stopping = false;

async function main() {
  const svc = getServices("worker");
  const db = getDb();
  const startedAt = new Date();
  console.log(`[worker] ${svc.workerId} started (tick ${TICK_MS} ms, sync ${webhooksEnabled() ? "webhooks + safety poll" : "polling"} every ${POLL_MINUTES} min)`);
  // Forget heartbeats of workers that died without a clean shutdown (> 10 min silent).
  await db.delete(s.workerHeartbeats).where(lt(s.workerHeartbeats.lastBeatAt, new Date(Date.now() - 10 * 60_000)));
  let lastPoll = 0;
  let lastRenew = 0;
  let lastGeo = 0;

  const loop = async () => {
    const now = svc.clock.now();
    await db.insert(s.workerHeartbeats).values({ workerId: svc.workerId, startedAt, lastBeatAt: now, info: { pid: process.pid, tickMs: TICK_MS } })
      .onConflictDoUpdate({ target: s.workerHeartbeats.workerId, set: { lastBeatAt: now } });

    const d = await dispatchTick(svc);
    if (d.claimed || d.recovered) console.log("[worker] dispatch", JSON.stringify(d));

    // Periodic work
    if (Date.now() - lastPoll > POLL_MINUTES * 60_000) {
      lastPoll = Date.now();
      const mbs = await db.select().from(s.mailboxes).where(eq(s.mailboxes.status, "connected"));
      for (const mb of mbs) await reschedulePeriodic(db, "mailbox_sync", `sync:${mb.id}:periodic`, now, { mailboxId: mb.id }, mb.ownerId);
    }
    if (Date.now() - lastRenew > 60 * 60_000) {
      lastRenew = Date.now();
      await renewSubscriptions(svc).catch((e) => console.error("[worker] renew", errorSummary(e)));
    }
    if (Date.now() - lastGeo > 60_000) {
      lastGeo = Date.now();
      // Offline centroids need no rate limit; a real geocoder is throttled inside geocodePending.
      await geocodePending(svc, geocoderConfig().provider === "none" ? 1000 : 20).catch((e) => console.error("[worker] geocode", errorSummary(e)));
    }
    await runDiscoveryStep(svc, 3).catch((e) => console.error("[worker] discovery", errorSummary(e)));

    for (const job of await claimJobs(db, { workerId: svc.workerId, now: svc.clock.now(), limit: 10 })) {
      try {
        const p = job.payload as Record<string, string>;
        if (job.kind === "reconcile_send") await reconcileSend(svc, p.sendId);
        else if (job.kind === "mailbox_sync") {
          const r = await syncMailbox(svc, p.mailboxId);
          if (r.errors.length) console.warn("[worker] sync errors", r.errors.join("; "));
        } else if (job.kind === "renew_subscriptions") await renewSubscriptions(svc);
        else if (job.kind === "ensure_subscriptions") await ensureSubscriptions(svc, p.mailboxId);
        await completeJob(db, job.id, svc.workerId, svc.clock.now());
      } catch (e) {
        console.error(`[worker] job ${job.kind} failed:`, errorSummary(e));
        await failJob(db, job, e, svc.clock.now());
      }
    }
  };

  while (!stopping) {
    try {
      await loop();
    } catch (e) {
      // Database interruptions etc.: log and continue; work is durable.
      console.error("[worker] tick failed:", errorSummary(e));
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  await db.delete(s.workerHeartbeats).where(and(eq(s.workerHeartbeats.workerId, svc.workerId)));
  await closeDb();
  console.log("[worker] stopped cleanly");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; });
main().catch((e) => {
  console.error("[worker] fatal:", errorSummary(e));
  process.exit(1);
});
