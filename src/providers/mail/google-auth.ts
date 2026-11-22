/**
 * Google OAuth 2.0 (web server flow) for a Gmail mailbox, with PKCE and state.
 * Least privilege for the implemented features (verified against Google's
 * Gmail scope list; both Gmail scopes are classified "restricted"):
 *  - gmail.readonly  read Inbox/Sent (sync, reply matching, sent-copy lookup)
 *  - gmail.compose   create/update/delete drafts and send them
 *  - openid, email   identify the connected account
 * Refresh tokens require access_type=offline; prompt=consent makes Google issue
 * one on every connect (it is otherwise only returned the first time).
 * Use a Google Cloud project with the "Personal" user type (single creator
 * account): no verification, no unverified-app screen, no 7-day token expiry.
 * See docs/GMAIL.md.
 */
import { GraphAuthError as OAuthTokenError, type TokenSet } from "./graph-auth";

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleAuthConfig(): GoogleAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || (process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/api/oauth/google/callback` : undefined);
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function googleAuthorizeUrl(cfg: GoogleAuthConfig, state: string, challenge: string, loginHint?: string) {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  } catch (e) {
    throw new OAuthTokenError("transient", `Google token endpoint unreachable: ${(e as Error).name}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    if (body.error === "invalid_grant") throw new OAuthTokenError("invalid_grant", "Google sign-in expired or was revoked; reconnect the mailbox.");
    if (body.error === "admin_policy_enforced" || body.error === "access_denied") throw new OAuthTokenError("consent_required", "Google refused access to this account for the app.", body.error);
    if (res.status >= 500) throw new OAuthTokenError("transient", `Google token endpoint ${res.status}`);
    throw new OAuthTokenError("config", `Google token request failed: ${body.error ?? res.status}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (Number(body.expires_in ?? 3600) - 60) * 1000),
    scope: body.scope ?? "",
  };
}

export function exchangeGoogleCode(cfg: GoogleAuthConfig, code: string, verifier: string, fetchImpl?: typeof fetch) {
  return tokenRequest({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier }, fetchImpl);
}

export function refreshGoogleTokens(cfg: GoogleAuthConfig, refreshToken: string, fetchImpl?: typeof fetch) {
  return tokenRequest({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/** Best-effort revocation on disconnect (also invalidates the refresh token). */
export async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = fetch) {
  await fetchImpl(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }).catch(() => undefined);
}

/** True when the granted scopes cover what the app needs (users can untick scopes on Google's consent screen). */
export function hasRequiredGoogleScopes(granted: string) {
  const g = new Set(granted.split(/\s+/));
  return ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"].every((s) => g.has(s));
}
