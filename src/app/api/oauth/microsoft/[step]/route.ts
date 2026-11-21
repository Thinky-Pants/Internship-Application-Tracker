/**
 * Outlook connection (delegated OAuth, auth-code + PKCE). The state value and
 * PKCE verifier live in a short-lived httpOnly cookie bound to the owner
 * session. Tokens are encrypted at rest (APP_ENCRYPTION_KEY). Consent
 * restrictions (e.g. a university tenant) produce a "restricted" mailbox with
 * instructions; pending schedules remain held, not lost.
 */
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { getServices, isDemoMode } from "@/server/runtime";
import { apiOwner, handler } from "@/server/http";
import { authorizeUrl, exchangeCode, graphAuthConfig, GraphAuthError, pkcePair } from "@/providers/mail/graph-auth";
import { GraphMailProvider } from "@/providers/mail/graph";
import { encryptSecret, randomToken, sha256Hex } from "@/lib/crypto";
import { ensureFolders } from "@/domain/mail/sync";
import { enqueueJob } from "@/domain/jobs";
import { ensureSubscriptions } from "@/domain/mail/subscriptions";

const COOKIE = "iom_oauth";
const redirectTo = (path: string, req: Request) => Response.redirect(new URL(path, process.env.APP_BASE_URL ?? req.url), 302);

export const GET = handler(async (req: Request, ctx: { params: Promise<{ step: string }> }) => {
  const owner = await apiOwner();
  const { step } = await ctx.params;
  const cfg = graphAuthConfig();
  if (isDemoMode()) return redirectTo("/settings?err=" + encodeURIComponent("Demo mode never connects a real mailbox."), req);
  if (!cfg) return redirectTo("/settings?err=" + encodeURIComponent("Microsoft app registration is not configured (MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI)."), req);
  const jar = await cookies();
  if (step === "start") {
    const state = randomToken(24);
    const { verifier, challenge } = pkcePair();
    jar.set(COOKIE, JSON.stringify({ state, verifier, owner: owner.id }), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/oauth/microsoft", maxAge: 600 });
    return Response.redirect(authorizeUrl(cfg, state, challenge), 302);
  }
  if (step !== "callback") return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const raw = jar.get(COOKIE)?.value;
  jar.delete(COOKIE);
  const saved = raw ? (JSON.parse(raw) as { state: string; verifier: string; owner: string }) : null;
  if (!saved || saved.owner !== owner.id || saved.state !== url.searchParams.get("state")) return redirectTo("/settings?err=" + encodeURIComponent("Sign-in state did not match; please try connecting again."), req);
  const err = url.searchParams.get("error");
  if (err) {
    const desc = url.searchParams.get("error_description") ?? "";
    const consent = /AADSTS65001|AADSTS90094|consent|admin/i.test(desc + err);
    return redirectTo("/settings?err=" + encodeURIComponent(consent ? "Your organisation requires admin approval for this app. Ask IT to grant consent (see docs/OUTLOOK.md) or connect a personal Outlook account. Scheduled work is kept." : `Microsoft sign-in failed: ${err}`), req);
  }
  const svc = getServices();
  try {
    const tokens = await exchangeCode(cfg, url.searchParams.get("code") ?? "", saved.verifier);
    const graph = new GraphMailProvider();
    const id = await graph.getIdentity({ mailboxId: "new", accessToken: tokens.accessToken });
    const [existing] = await svc.db.select().from(s.mailboxes).where(and(eq(s.mailboxes.ownerId, owner.id), eq(s.mailboxes.provider, "graph"), eq(s.mailboxes.providerUserId, id.providerUserId)));
    const vals = {
      ownerId: owner.id, provider: "graph", emailAddress: id.emailAddress, displayName: id.displayName, providerUserId: id.providerUserId, status: "connected", statusReason: null,
      scopes: tokens.scope, accessTokenEnc: encryptSecret(tokens.accessToken), refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null, tokenExpiresAt: tokens.expiresAt, connectedAt: new Date(), updatedAt: new Date(),
    };
    let mailboxId: string;
    if (existing) {
      await svc.db.update(s.mailboxes).set(vals).where(eq(s.mailboxes.id, existing.id));
      mailboxId = existing.id;
    } else mailboxId = (await svc.db.insert(s.mailboxes).values(vals).returning())[0].id;
    await ensureFolders(svc, mailboxId);
    await ensureSubscriptions(svc, mailboxId).catch((e) => console.warn("[oauth] subscriptions:", (e as Error).message));
    await enqueueJob(svc.db, { ownerId: owner.id, kind: "mailbox_sync", payload: { mailboxId }, dedupeKey: `sync:${mailboxId}:pending` });
    void sha256Hex;
    return redirectTo(`/settings?msg=${encodeURIComponent(`Connected ${id.emailAddress}. Initial sync covers the last ${90} days of tracked folders.`)}`, req);
  } catch (e) {
    const msg = e instanceof GraphAuthError && e.kind === "consent_required" ? "Admin approval required by your organisation (see docs/OUTLOOK.md)." : `Could not complete connection: ${(e as Error).message}`;
    return redirectTo("/settings?err=" + encodeURIComponent(msg), req);
  }
});
