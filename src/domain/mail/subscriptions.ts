/**
 * Cloud webhook mode (Graph change notifications). Only enabled when
 * PUBLIC_BASE_URL is HTTPS and WEBHOOKS_ENABLED=1; otherwise the worker polls.
 * Notifications only trigger an incremental delta sync — they are never
 * trusted as message content. Subscriptions are renewed well before their
 * 10,080-minute maximum; lifecycle events (reauthorizationRequired,
 * subscriptionRemoved, missed) cause renew/recreate plus a recovery sync.
 */
import { and, eq, lt } from "drizzle-orm";
import * as s from "@/db/schema";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { errorSummary } from "@/lib/redact";
import { getMailAccess } from "./access";
import { enqueueJob } from "../jobs";
import { GraphMailProvider } from "@/providers/mail/graph";
import type { Services } from "../services";

export const SUBSCRIPTION_MINUTES = 4 * 24 * 60; // renew at ~half the 7-day maximum

export function webhooksEnabled() {
  return process.env.WEBHOOKS_ENABLED === "1" && (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://");
}

export async function ensureSubscriptions(svc: Services, mailboxId: string) {
  if (!webhooksEnabled()) return { mode: "polling" as const };
  const { provider, ctx, mailbox } = await getMailAccess(svc, mailboxId);
  if (!(provider instanceof GraphMailProvider)) return { mode: "polling" as const };
  const base = process.env.PUBLIC_BASE_URL!;
  const folders = await svc.db.select().from(s.mailboxFolders).where(and(eq(s.mailboxFolders.mailboxId, mailbox.id), eq(s.mailboxFolders.tracked, true)));
  const existing = await svc.db.select().from(s.mailboxSubscriptions).where(eq(s.mailboxSubscriptions.mailboxId, mailbox.id));
  for (const f of folders) {
    const resource = `/me/mailFolders('${f.providerFolderId}')/messages`;
    if (existing.some((e) => e.resource === resource && e.status === "active")) continue;
    const clientState = randomToken(24);
    const expires = new Date(svc.clock.now().getTime() + SUBSCRIPTION_MINUTES * 60_000);
    const sub = await provider.createSubscription(ctx, { folderId: f.providerFolderId, notificationUrl: `${base}/api/webhooks/graph`, lifecycleUrl: `${base}/api/webhooks/graph?lifecycle=1`, clientState, expires });
    await svc.db.insert(s.mailboxSubscriptions).values({ mailboxId: mailbox.id, providerSubscriptionId: sub.id, resource, clientStateHash: sha256Hex(clientState), expiresAt: sub.expiresAt });
  }
  return { mode: "webhooks" as const };
}

export async function renewSubscriptions(svc: Services) {
  const soon = new Date(svc.clock.now().getTime() + 24 * 3600_000);
  const subs = await svc.db.select().from(s.mailboxSubscriptions).where(and(eq(s.mailboxSubscriptions.status, "active"), lt(s.mailboxSubscriptions.expiresAt, soon)));
  for (const sub of subs) {
    try {
      const { provider, ctx } = await getMailAccess(svc, sub.mailboxId);
      if (!(provider instanceof GraphMailProvider)) continue;
      const exp = await provider.renewSubscription(ctx, sub.providerSubscriptionId, new Date(svc.clock.now().getTime() + SUBSCRIPTION_MINUTES * 60_000));
      await svc.db.update(s.mailboxSubscriptions).set({ expiresAt: exp }).where(eq(s.mailboxSubscriptions.id, sub.id));
    } catch (e) {
      console.error("[subscriptions] renew failed:", errorSummary(e));
      await svc.db.update(s.mailboxSubscriptions).set({ status: "expired" }).where(eq(s.mailboxSubscriptions.id, sub.id));
      await enqueueJob(svc.db, { kind: "mailbox_sync", payload: { mailboxId: sub.mailboxId }, dedupeKey: `sync:${sub.mailboxId}:recover:${Date.now()}` });
    }
  }
}

/**
 * Handle a validated notification batch quickly: record (deduplicated) and
 * enqueue a sync. Returns the number of new notifications.
 */
export async function recordNotifications(svc: Services, body: { value?: Record<string, any>[] }, lifecycle: boolean) {
  let n = 0;
  for (const v of body.value ?? []) {
    const subId = String(v.subscriptionId ?? "");
    const [sub] = await svc.db.select().from(s.mailboxSubscriptions).where(eq(s.mailboxSubscriptions.providerSubscriptionId, subId));
    if (!sub || sha256Hex(String(v.clientState ?? "")) !== sub.clientStateHash) continue; // not from Graph / unknown
    const key = sha256Hex(`${subId}|${v.lifecycleEvent ?? ""}|${v.changeType ?? ""}|${v.resource ?? ""}|${v.subscriptionExpirationDateTime ?? ""}`);
    const ins = await svc.db.insert(s.webhookNotifications).values({ dedupeKey: key, subscriptionId: subId, lifecycleEvent: v.lifecycleEvent ?? null, payload: { changeType: v.changeType, resource: v.resource, lifecycleEvent: v.lifecycleEvent } }).onConflictDoNothing().returning();
    if (!ins.length) continue;
    n++;
    await svc.db.update(s.mailboxSubscriptions).set({ lastNotificationAt: svc.clock.now(), ...(lifecycle && v.lifecycleEvent === "subscriptionRemoved" ? { status: "removed" } : {}) }).where(eq(s.mailboxSubscriptions.id, sub.id));
    if (lifecycle && v.lifecycleEvent === "reauthorizationRequired") await enqueueJob(svc.db, { kind: "renew_subscriptions", dedupeKey: `renew:${sub.id}:${Date.now()}` });
    if (lifecycle && v.lifecycleEvent === "subscriptionRemoved") await enqueueJob(svc.db, { kind: "ensure_subscriptions", payload: { mailboxId: sub.mailboxId }, dedupeKey: `ensure:${sub.mailboxId}:${Date.now()}` });
    // Coalesce: at most one pending sync per mailbox.
    await enqueueJob(svc.db, { kind: "mailbox_sync", payload: { mailboxId: sub.mailboxId }, dedupeKey: `sync:${sub.mailboxId}:pending` });
  }
  return n;
}
