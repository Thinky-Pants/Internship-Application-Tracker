/**
 * Resolve a usable provider + access token for a mailbox, refreshing Graph
 * tokens as needed, and record health transitions:
 *   connected → expired (refresh failed / 401) → reconnect required
 *   connected → restricted (tenant consent / admin approval needed)
 *   disconnected (user action) — sends for it are held, never dropped.
 */
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { errorSummary } from "@/lib/redact";
import type { Services } from "../services";
import { MailProviderError, type MailContext, type MailProvider } from "@/providers/mail/types";
import { GraphAuthError } from "@/providers/mail/graph-auth";

export class MailboxUnavailable extends Error {
  constructor(public status: string, public reason: string) {
    super(`Mailbox ${status}: ${reason}`);
  }
}

export type Mailbox = typeof s.mailboxes.$inferSelect;

export async function getMailAccess(svc: Services, mailboxId: string): Promise<{ mailbox: Mailbox; provider: MailProvider; ctx: MailContext }> {
  const [mb] = await svc.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mailboxId));
  if (!mb) throw new MailboxUnavailable("missing", "Mailbox record not found.");
  if (mb.status !== "connected") throw new MailboxUnavailable(mb.status, mb.statusReason ?? `Mailbox is ${mb.status}.`);
  const provider = svc.mailProvider(mb.provider);
  if (mb.provider === "mock") {
    return { mailbox: mb, provider, ctx: { mailboxId: mb.id, accessToken: mb.accessTokenEnc ? decryptSecret(mb.accessTokenEnc) : `mock-token-${mb.id}` } };
  }
  const now = svc.clock.now();
  if (mb.accessTokenEnc && mb.tokenExpiresAt && mb.tokenExpiresAt > new Date(now.getTime() + 60_000)) {
    return { mailbox: mb, provider, ctx: { mailboxId: mb.id, accessToken: decryptSecret(mb.accessTokenEnc) } };
  }
  if (!mb.refreshTokenEnc || !svc.refreshGraphToken) {
    await markMailbox(svc, mb.id, "expired", "No refresh token available; reconnect the mailbox.");
    throw new MailboxUnavailable("expired", "No refresh token available; reconnect the mailbox.");
  }
  try {
    const t = await svc.refreshGraphToken(decryptSecret(mb.refreshTokenEnc));
    await svc.db.update(s.mailboxes).set({
      accessTokenEnc: encryptSecret(t.accessToken),
      refreshTokenEnc: t.refreshToken ? encryptSecret(t.refreshToken) : mb.refreshTokenEnc,
      tokenExpiresAt: t.expiresAt,
      updatedAt: now,
    }).where(eq(s.mailboxes.id, mb.id));
    return { mailbox: mb, provider, ctx: { mailboxId: mb.id, accessToken: t.accessToken } };
  } catch (e) {
    if (e instanceof GraphAuthError && e.kind === "transient") throw new MailboxUnavailable("connected", "Token endpoint temporarily unavailable.");
    const restricted = e instanceof GraphAuthError && e.kind === "consent_required";
    const reason = restricted ? "Your organisation requires admin approval for this app. Ask your IT admin, or connect a personal mailbox." : `Sign-in expired: ${errorSummary(e)}`;
    await markMailbox(svc, mb.id, restricted ? "restricted" : "expired", reason);
    throw new MailboxUnavailable(restricted ? "restricted" : "expired", reason);
  }
}

export async function markMailbox(svc: Services, mailboxId: string, status: string, reason: string) {
  await svc.db.update(s.mailboxes).set({ status, statusReason: reason, updatedAt: svc.clock.now() }).where(eq(s.mailboxes.id, mailboxId));
}

/** Translate provider auth errors into mailbox health; returns true if handled. */
export async function handleAuthError(svc: Services, mailboxId: string, err: unknown): Promise<boolean> {
  if (!(err instanceof MailProviderError)) return false;
  if (err.kind === "auth_expired") {
    await markMailbox(svc, mailboxId, "expired", "Microsoft rejected the access token (expired or revoked). Reconnect the mailbox.");
    return true;
  }
  if (err.kind === "consent_required") {
    await markMailbox(svc, mailboxId, "restricted", "Permission denied by the tenant (consent/admin approval required).");
    return true;
  }
  return false;
}
