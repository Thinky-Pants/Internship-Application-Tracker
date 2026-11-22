"use server";
import fs from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getServices, isDemoMode } from "@/server/runtime";
import { back, errMessage } from "@/server/flash";
import * as s from "@/db/schema";
import { decryptSecret, encryptSecret, encryptionConfigured } from "@/lib/crypto";
import { revokeGoogleToken } from "@/providers/mail/google-auth";
import { isValidZone } from "@/domain/scheduling/time";
import { logTransition } from "@/domain/dispatch/states";
import { ensureFolders } from "@/domain/mail/sync";
import { enqueueJob } from "@/domain/jobs";
import { audit } from "@/domain/audit";
import { GraphMailProvider } from "@/providers/mail/graph";
import { getMailAccess } from "@/domain/mail/access";
import { ApolloRestProvider } from "@/providers/apollo/rest";
import { ApolloError } from "@/providers/apollo/types";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

export async function savePreferencesAction(fd: FormData) {
  const o = await requireOwner();
  const tz = str(fd, "displayTimezone") ?? "Asia/Riyadh";
  if (!isValidZone(tz)) back("/settings", { err: `Unknown timezone ${tz}.` });
  const days = fd.getAll("days").map(Number).filter((d) => d >= 1 && d <= 7);
  const start = str(fd, "start") ?? "07:00";
  const end = str(fd, "end") ?? "18:00";
  if (!days.length || start >= end) back("/settings", { err: "Choose at least one day and a start time before the end time." });
  await getServices().db.update(s.settings).set({
    displayTimezone: tz,
    sendingWindow: { days, start, end },
    missedSendGraceMinutes: Number(fd.get("grace") ?? 120),
    companyCoordinationPolicy: fd.get("policy") === "pause_contact_only" ? "pause_contact_only" : "pause_company",
    followupMaxSyncAgeMinutes: Number(fd.get("syncAge") ?? 60),
    keepApprovalOnReschedule: fd.get("keepApproval") === "1",
    setupCompletedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(s.settings.ownerId, o.id));
  back("/settings", { msg: "Preferences saved." });
}

export async function saveMailboxLimitsAction(fd: FormData) {
  const o = await requireOwner();
  const id = String(fd.get("mailboxId"));
  await getServices().db.update(s.mailboxes).set({ dailyLimit: Math.max(1, Number(fd.get("daily"))), hourlyLimit: Math.max(1, Number(fd.get("hourly"))), minSpacingSeconds: Math.max(0, Number(fd.get("spacing"))), initialSyncDays: Math.max(1, Math.min(365, Number(fd.get("syncDays") ?? 90))) }).where(and(eq(s.mailboxes.id, id), eq(s.mailboxes.ownerId, o.id)));
  back("/settings#mailboxes", { msg: "Mailbox limits saved. These are your own conservative limits — provider limits differ per account." });
}

export async function toggleFolderAction(fd: FormData) {
  const o = await requireOwner();
  const db = getServices().db;
  const [f] = await db.select({ f: s.mailboxFolders, m: s.mailboxes }).from(s.mailboxFolders).innerJoin(s.mailboxes, eq(s.mailboxes.id, s.mailboxFolders.mailboxId)).where(eq(s.mailboxFolders.id, String(fd.get("folderId"))));
  if (f?.m.ownerId === o.id) await db.update(s.mailboxFolders).set({ tracked: fd.get("on") === "1", deltaLink: null }).where(eq(s.mailboxFolders.id, f.f.id));
  back("/settings#mailboxes", { msg: "Folder tracking updated." });
}

export async function refreshFoldersAction(fd: FormData) {
  const o = await requireOwner();
  try {
    const svc = getServices();
    const [mb] = await svc.db.select().from(s.mailboxes).where(and(eq(s.mailboxes.id, String(fd.get("mailboxId"))), eq(s.mailboxes.ownerId, o.id)));
    if (!mb) throw new Error("Mailbox not found.");
    await ensureFolders(svc, mb.id);
    await enqueueJob(svc.db, { ownerId: o.id, kind: "mailbox_sync", payload: { mailboxId: mb.id }, dedupeKey: `sync:${mb.id}:pending` });
  } catch (e) {
    back("/settings#mailboxes", { err: errMessage(e) });
  }
  back("/settings#mailboxes", { msg: "Folders discovered; sync queued." });
}

/**
 * Disconnect: holds (never deletes) this mailbox's pending sends, removes
 * stored tokens, and keeps all message history.
 */
export async function disconnectMailboxAction(fd: FormData) {
  const o = await requireOwner();
  const svc = getServices();
  const id = String(fd.get("mailboxId"));
  const [mb] = await svc.db.select().from(s.mailboxes).where(and(eq(s.mailboxes.id, id), eq(s.mailboxes.ownerId, o.id)));
  if (!mb) back("/settings", { err: "Mailbox not found." });
  // Best effort: remove change-notification subscriptions while tokens still work.
  if (mb!.provider === "graph") {
    try {
      const { ctx } = await getMailAccess(svc, id);
      const subs = await svc.db.select().from(s.mailboxSubscriptions).where(eq(s.mailboxSubscriptions.mailboxId, id));
      for (const sub of subs) await new GraphMailProvider().deleteSubscription(ctx, sub.providerSubscriptionId).catch(() => undefined);
    } catch {
      /* tokens may already be invalid */
    }
  }
  // Gmail: revoke the refresh token at Google so the grant is fully removed.
  if (mb!.provider === "gmail" && mb!.refreshTokenEnc) {
    try {
      await revokeGoogleToken(decryptSecret(mb!.refreshTokenEnc));
    } catch {
      /* best effort */
    }
  }
  const sends = await svc.db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.mailboxId, id), inArray(s.scheduledSends.state, ["scheduled", "paused"])));
  for (const sd of sends) {
    const [u] = await svc.db.update(s.scheduledSends).set({ state: "held", holdReason: "Mailbox disconnected — reconnect to resume", version: sd.version + 1 }).where(and(eq(s.scheduledSends.id, sd.id), eq(s.scheduledSends.version, sd.version))).returning();
    if (u) await logTransition(svc.db, { ownerId: o.id, scheduledSendId: sd.id, messageId: sd.messageId, from: sd.state, to: "held", actor: "user", reason: "mailbox disconnected" });
  }
  await svc.db.update(s.mailboxes).set({ status: "disconnected", statusReason: "Disconnected by owner. Tokens removed; history retained.", accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null }).where(eq(s.mailboxes.id, id));
  await svc.db.update(s.mailboxSubscriptions).set({ status: "removed" }).where(eq(s.mailboxSubscriptions.mailboxId, id));
  await audit(svc.db, { ownerId: o.id, entityType: "mailbox", entityId: id, action: "disconnect", after: { heldSends: sends.length } });
  const revokeHint = mb!.provider === "gmail" ? "Access was revoked at Google (you can confirm at myaccount.google.com/permissions)." : "To fully revoke the app's access also remove it at https://account.live.com/consent/Manage or https://myapplications.microsoft.com.";
  back("/settings#mailboxes", { msg: `Disconnected. ${sends.length} pending send(s) are held (not deleted). Stored tokens were removed. ${revokeHint}` });
}

export async function addMockMailboxAction() {
  const o = await requireOwner();
  if (!isDemoMode() && process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_MAILBOX !== "1") back("/settings", { err: "Mock mailboxes are only available in demo or development mode." });
  const [mb] = await getServices().db.insert(s.mailboxes).values({ ownerId: o.id, provider: "mock", emailAddress: "demo.student@example.test", displayName: "Mock mailbox (never sends)", status: "connected", connectedAt: new Date(), isDemo: true, minSpacingSeconds: 60 }).returning();
  await ensureFolders(getServices(), mb.id);
  back("/settings#mailboxes", { msg: "Mock mailbox added. It simulates a real mailbox and never sends real mail." });
}

export async function reconnectMockAction(fd: FormData) {
  const o = await requireOwner();
  await getServices().db.update(s.mailboxes).set({ status: "connected", statusReason: null }).where(and(eq(s.mailboxes.id, String(fd.get("mailboxId"))), eq(s.mailboxes.ownerId, o.id), eq(s.mailboxes.provider, "mock")));
  back("/settings#mailboxes", { msg: "Mock mailbox reconnected; held sends can be resumed from the queue." });
}

export async function saveProviderKeyAction(fd: FormData) {
  const o = await requireOwner();
  const provider = String(fd.get("provider"));
  if (!["apollo", "openai", "anthropic"].includes(provider)) back("/settings", { err: "Unknown provider." });
  if (!encryptionConfigured()) back("/settings", { err: "Set APP_ENCRYPTION_KEY first (see .env.example); keys are stored encrypted." });
  const key = str(fd, "apiKey");
  const config = { model: str(fd, "model") ?? undefined, monthlyTokenBudget: Number(fd.get("budget") ?? 0) || undefined, creditBudget: Number(fd.get("creditBudget") ?? 0) || undefined };
  const db = getServices().db;
  const [existing] = await db.select().from(s.providerCredentials).where(and(eq(s.providerCredentials.ownerId, o.id), eq(s.providerCredentials.provider, provider)));
  const vals = { config, ...(key ? { secretEnc: encryptSecret(key), status: "connected", statusReason: "Key stored (not yet tested)" } : {}), updatedAt: new Date() };
  if (existing) await db.update(s.providerCredentials).set(vals).where(eq(s.providerCredentials.id, existing.id));
  else await db.insert(s.providerCredentials).values({ ownerId: o.id, provider, ...vals });
  back("/settings#integrations", { msg: `${provider} settings saved${key ? " (key encrypted server-side; it is never shown again)" : ""}.` });
}

export async function removeProviderKeyAction(fd: FormData) {
  const o = await requireOwner();
  await getServices().db.update(s.providerCredentials).set({ secretEnc: null, status: "unconfigured", statusReason: "Removed by owner" }).where(and(eq(s.providerCredentials.ownerId, o.id), eq(s.providerCredentials.provider, String(fd.get("provider")))));
  back("/settings#integrations", { msg: "Key removed." });
}

/** Explicit owner-initiated connectivity test: one People Search request (documented as 0 credits). */
export async function testApolloAction(fd: FormData) {
  const o = await requireOwner();
  const svc = getServices();
  const apollo = await svc.apollo(o.id);
  if (!apollo) back("/settings#integrations", { err: "Apollo is not configured." });
  const domain = str(fd, "domain") ?? "apollo.io";
  let status = "connected";
  let reason = "";
  try {
    const r = await apollo!.searchPeople({ domain, perPage: 1 });
    reason = `Search OK (${r.total} people at ${domain}). Enrichment eligibility is only known when you enrich.`;
  } catch (e) {
    const ae = e as ApolloError;
    status = ae.kind === "access_denied" ? "restricted" : "error";
    reason = `${ae.kind}: ${ae.message}`;
  }
  void ApolloRestProvider;
  await svc.db.update(s.providerCredentials).set({ status, statusReason: reason }).where(and(eq(s.providerCredentials.ownerId, o.id), eq(s.providerCredentials.provider, "apollo")));
  back("/settings#integrations", status === "connected" ? { msg: reason } : { err: reason });
}

export async function saveMapConfigAction(fd: FormData) {
  const o = await requireOwner();
  await getServices().db.update(s.settings).set({ mapConfig: { styleUrl: str(fd, "styleUrl") ?? undefined, attribution: str(fd, "attribution") ?? undefined } }).where(eq(s.settings.ownerId, o.id));
  back("/settings#map", { msg: "Map tile settings saved." });
}

export async function saveHeuristicsAction(fd: FormData) {
  const o = await requireOwner();
  try {
    const parsed = JSON.parse(String(fd.get("json") ?? "{}"));
    await getServices().db.update(s.settings).set({ roleHeuristics: parsed }).where(eq(s.settings.ownerId, o.id));
  } catch (e) {
    back("/settings#heuristics", { err: `Invalid JSON: ${errMessage(e)}` });
  }
  back("/settings#heuristics", { msg: "Role heuristics saved." });
}

export async function advanceDemoClockAction(fd: FormData) {
  await requireOwner();
  if (!isDemoMode()) back("/settings", { err: "Simulated time is only available in demo mode." });
  const file = "data/demo-clock-offset";
  let cur = 0;
  try {
    cur = Number(fs.readFileSync(file, "utf8")) || 0;
  } catch {
    /* none */
  }
  const add = fd.get("reset") === "1" ? -cur : Number(fd.get("hours") ?? 0) * 3600_000;
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(file, String(cur + add));
  back("/settings#demo", { msg: `Simulated clock offset is now ${Math.round((cur + add) / 3600_000)} h. The worker picks it up on its next tick.` });
}
