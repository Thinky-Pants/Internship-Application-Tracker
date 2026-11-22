/**
 * Gmail connection (Google OAuth web-server flow with PKCE). The state value
 * and PKCE verifier live in a short-lived httpOnly cookie bound to the owner
 * session. Tokens are encrypted at rest (APP_ENCRYPTION_KEY).
 */
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { getServices, isDemoMode } from "@/server/runtime";
import { apiOwner, handler } from "@/server/http";
import { pkcePair } from "@/providers/mail/graph-auth";
import { exchangeGoogleCode, googleAuthConfig, googleAuthorizeUrl, hasRequiredGoogleScopes } from "@/providers/mail/google-auth";
import { GmailMailProvider } from "@/providers/mail/gmail";
import { encryptSecret, randomToken } from "@/lib/crypto";
import { errorSummary } from "@/lib/redact";
import { ensureFolders } from "@/domain/mail/sync";
import { enqueueJob } from "@/domain/jobs";

const COOKIE = "iom_oauth_google";
const redirectTo = (path: string, req: Request) => Response.redirect(new URL(path, process.env.APP_BASE_URL ?? req.url), 302);
const fail = (req: Request, msg: string) => redirectTo("/settings?err=" + encodeURIComponent(msg) + "#mailboxes", req);

export const GET = handler(async (req: Request, ctx: { params: Promise<{ step: string }> }) => {
  const owner = await apiOwner();
  const { step } = await ctx.params;
  const cfg = googleAuthConfig();
  if (isDemoMode()) return fail(req, "Demo mode never connects a real mailbox.");
  if (!cfg) return fail(req, "Google OAuth client is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI). See docs/GMAIL.md.");
  const jar = await cookies();
  if (step === "start") {
    const state = randomToken(24);
    const { verifier, challenge } = pkcePair();
    jar.set(COOKIE, JSON.stringify({ state, verifier, owner: owner.id }), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1", path: "/api/oauth/google", maxAge: 600 });
    return Response.redirect(googleAuthorizeUrl(cfg, state, challenge), 302);
  }
  if (step !== "callback") return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const raw = jar.get(COOKIE)?.value;
  jar.delete(COOKIE);
  const saved = raw ? (JSON.parse(raw) as { state: string; verifier: string; owner: string }) : null;
  if (!saved || saved.owner !== owner.id || saved.state !== url.searchParams.get("state")) return fail(req, "Sign-in state did not match; please try connecting again.");
  const err = url.searchParams.get("error");
  if (err) return fail(req, err === "access_denied" ? "Google sign-in was cancelled or access was denied. Nothing was connected." : `Google sign-in failed: ${err}`);
  const svc = getServices();
  try {
    const tokens = await exchangeGoogleCode(cfg, url.searchParams.get("code") ?? "", saved.verifier);
    if (!hasRequiredGoogleScopes(tokens.scope)) return fail(req, "Some permissions were left unticked on Google's consent screen. Reconnect and allow reading and composing/sending Gmail; the app needs both.");
    if (!tokens.refreshToken) return fail(req, "Google did not return a refresh token, so the worker could not act while you are away. Remove the app's access at myaccount.google.com/permissions and connect again.");
    const id = await new GmailMailProvider().getIdentity({ mailboxId: "new", accessToken: tokens.accessToken });
    const [existing] = await svc.db.select().from(s.mailboxes).where(and(eq(s.mailboxes.ownerId, owner.id), eq(s.mailboxes.provider, "gmail"), eq(s.mailboxes.providerUserId, id.providerUserId)));
    const vals = {
      ownerId: owner.id, provider: "gmail", emailAddress: id.emailAddress, displayName: id.displayName, providerUserId: id.providerUserId, status: "connected", statusReason: null,
      scopes: tokens.scope, accessTokenEnc: encryptSecret(tokens.accessToken), refreshTokenEnc: encryptSecret(tokens.refreshToken), tokenExpiresAt: tokens.expiresAt, connectedAt: new Date(), updatedAt: new Date(),
    };
    let mailboxId: string;
    if (existing) {
      await svc.db.update(s.mailboxes).set(vals).where(eq(s.mailboxes.id, existing.id));
      mailboxId = existing.id;
    } else mailboxId = (await svc.db.insert(s.mailboxes).values(vals).returning())[0].id;
    await ensureFolders(svc, mailboxId);
    await enqueueJob(svc.db, { ownerId: owner.id, kind: "mailbox_sync", payload: { mailboxId }, dedupeKey: `sync:${mailboxId}:pending` });
    return redirectTo(`/settings?msg=${encodeURIComponent(`Connected ${id.emailAddress}. The first sync covers Inbox and Sent from the last 90 days.`)}#mailboxes`, req);
  } catch (e) {
    return fail(req, `Could not complete the Gmail connection: ${errorSummary(e)}`);
  }
});
