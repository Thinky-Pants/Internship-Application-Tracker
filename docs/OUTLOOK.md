# Outlook (Microsoft Graph) setup

The app uses **delegated** permissions: you sign in to the mailbox and the app acts as you. It never asks for your mailbox password.

## 1. Register the application (Microsoft Entra ID)

1. Go to https://entra.microsoft.com → **Applications → App registrations → New registration**.
2. **Name:** e.g. "Internship Outreach Manager (private)".
3. **Supported account types:**
   - Personal Outlook.com/Hotmail mailbox → "Personal Microsoft accounts only" (set `MS_TENANT=consumers`), or
   - Both personal and work/school → "Accounts in any organizational directory and personal Microsoft accounts" (`MS_TENANT=common`).
4. **Redirect URI:** platform **Web**, value `http://localhost:3000/api/oauth/microsoft/callback` for local use. For a cloud deployment add `https://<your-domain>/api/oauth/microsoft/callback`. It must match `MS_REDIRECT_URI` exactly.
5. **Certificates & secrets → New client secret.** Copy the value into `MS_CLIENT_SECRET` (it is shown once). Note its expiry; renew before then.
6. Copy the **Application (client) ID** into `MS_CLIENT_ID`.

## 2. API permissions (delegated, least privilege for the implemented features)

| Permission | Why |
| --- | --- |
| `User.Read` | Identify the connected mailbox. |
| `Mail.ReadWrite` | Read Inbox/Sent Items (sync, reply matching), create and update drafts and reply drafts, attach CV PDFs. |
| `Mail.Send` | Send the approved draft. |
| `offline_access` | Refresh tokens, so the worker can act while you are away (must be requested explicitly). |
| `openid`, `profile` | Standard sign-in. |

`Mail.Read` alone is not enough because the app creates drafts. No application (app-only) permissions are used.

## 3. Consent

- Personal accounts: you consent on first sign-in.
- **Work/school (including university) accounts:** your organisation may disable user consent or require admin approval. You will then see an error such as AADSTS65001/AADSTS90094; the app marks the mailbox **restricted**, explains this, and keeps all schedules held. Using the API **does not** bypass university restrictions. Options: ask IT to grant admin consent for exactly the permissions above (see https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent), or connect a personal mailbox.

## 4. Connect

Settings → **Connect Outlook account**. After sign-in the app discovers folders, queues the first sync (last 90 days of tracked folders) and shows health: connected / expired / restricted / disconnected / error, token expiry, last sync.

**Disconnect** holds (does not delete) pending sends, deletes stored tokens and webhook subscriptions, and keeps message history. To revoke the app's consent entirely, remove it at https://account.live.com/consent/Manage (personal) or https://myapplications.microsoft.com (work/school).

## 5. Sync modes

- **Local (default):** polling every few minutes by the worker; no public URL needed.
- **Cloud webhooks:** set `WEBHOOKS_ENABLED=1` and `PUBLIC_BASE_URL=https://<your-domain>`. The endpoint `/api/webhooks/graph` answers the validation handshake (echoes `validationToken` as `text/plain` within 10 s), verifies `clientState`, acknowledges notifications with 202 within 3 s, deduplicates them and enqueues a delta sync. Lifecycle notifications use the same URL with `?lifecycle=1`. Subscriptions are renewed by the worker before expiry (Outlook message subscriptions last at most 10,080 minutes).

## 6. How sending works (and what it proves)

Draft-first: the worker creates a draft from the approved immutable revision (with `Prefer: IdType="ImmutableId"`), attaches the exact CV bytes (≤ 3 MB per attachment — larger CVs are rejected with a message because upload sessions are not implemented), records the draft's change key, then calls `POST /me/messages/{id}/send`. HTTP 202 means **accepted for processing**, not delivered. The worker then looks up the sent copy (the draft's immutable ID, falling back to `internetMessageId` in Sent Items) to record "sent".

### Drafts edited in Outlook

If the Outlook draft is changed outside the app after approval (detected by a different change key), the send is **held** with an explanation; it is never sent under the old approval. Deleted drafts are also held for review.

### Replies

Replies and follow-ups use `createReply` on the original message, so they stay in the same Outlook thread.

## Verification status

The Graph adapter is implemented against current Microsoft Learn documentation and unit/integration-tested through the provider interface with a deterministic mock. **It has not been exercised against a live mailbox in this build** — run docs/LIVE-TEST-CHECKLIST.md with a test address you own.
