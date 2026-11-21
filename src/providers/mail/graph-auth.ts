/**
 * Microsoft identity platform (v2.0) authorization-code flow with PKCE for a
 * confidential web client. Least privilege for the implemented features:
 *  - User.Read       identity of the signed-in mailbox
 *  - Mail.ReadWrite  read inbox/sent items, create/update drafts & reply drafts
 *  - Mail.Send       send drafts
 *  - offline_access  refresh tokens (must be requested explicitly)
 * A university/work tenant may block user consent; that surfaces as
 * "restricted" with instructions, and pending work is held, not lost.
 */
import crypto from "node:crypto";

export const GRAPH_SCOPES = ["openid", "profile", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];

export interface GraphAuthConfig {
  clientId: string;
  clientSecret: string;
  tenant: string; // "common" | "consumers" | "organizations" | tenant id
  redirectUri: string;
}

export function graphAuthConfig(): GraphAuthConfig | null {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const redirectUri = process.env.MS_REDIRECT_URI ?? (process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/api/oauth/microsoft/callback` : undefined);
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, tenant: process.env.MS_TENANT ?? "common", redirectUri };
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(cfg: GraphAuthConfig, state: string, challenge: string, loginHint?: string) {
  const u = new URL(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", GRAPH_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
}

export class GraphAuthError extends Error {
  constructor(public kind: "consent_required" | "invalid_grant" | "transient" | "config", message: string, public aadCode?: string) {
    super(message);
  }
}

async function tokenRequest(cfg: GraphAuthConfig, params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: GRAPH_SCOPES.join(" "), ...params }),
    });
  } catch (e) {
    throw new GraphAuthError("transient", `Token endpoint unreachable: ${(e as Error).name}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    const desc = body.error_description ?? "";
    const aad = desc.match(/AADSTS\d+/)?.[0];
    if (aad && ["AADSTS65001", "AADSTS90094", "AADSTS90095", "AADSTS65004"].includes(aad)) throw new GraphAuthError("consent_required", "The tenant requires admin approval or consent for this app.", aad);
    if (body.error === "invalid_grant" || body.error === "interaction_required") throw new GraphAuthError("invalid_grant", "Sign-in expired or was revoked; reconnect the mailbox.", aad);
    if (res.status >= 500) throw new GraphAuthError("transient", `Token endpoint ${res.status}`);
    throw new GraphAuthError("config", `Token request failed: ${body.error ?? res.status}`, aad);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (Number(body.expires_in ?? 3600) - 60) * 1000),
    scope: body.scope ?? "",
  };
}

export function exchangeCode(cfg: GraphAuthConfig, code: string, verifier: string, fetchImpl?: typeof fetch) {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier }, fetchImpl);
}

export function refreshTokens(cfg: GraphAuthConfig, refreshToken: string, fetchImpl?: typeof fetch) {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}
