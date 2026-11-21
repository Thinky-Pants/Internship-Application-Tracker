# Security, backups and data ownership

## Access

- Single owner. Every page, server action and route handler verifies the session; the Proxy only performs an optimistic redirect. Private files (CVs, uploaded imports) are only served through authenticated routes with `Cache-Control: private, no-store`.
- Sessions: random 256-bit tokens stored as SHA-256 hashes; httpOnly, SameSite=Lax, Secure in production; 14-day expiry; login throttling.
- CSRF: Server Actions are POST-only with Next.js origin checking; route handlers that mutate check `Origin`.
- OAuth: authorization code + PKCE + `state` bound to your session.
- Input validation on all actions; upload type/size limits (25 MB imports, 10 MB CV PDFs); inbound email HTML is sanitised and rendered as text by default; outbound HTML is allow-listed.
- Security headers: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`.
- The app performs no server-side fetching of arbitrary user-supplied URLs (research URLs are stored as links only), which avoids SSRF. Outbound requests go only to fixed provider hosts (Graph, login.microsoftonline.com, Apollo, AI APIs, the configured geocoder); the Graph client refuses non-Graph URLs and geocoder requests refuse redirects.

## Secrets

- Mailbox tokens and provider API keys are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY` (environment/secret manager, never the database). Rotate by setting the new key in `APP_ENCRYPTION_KEY` and the old one in `APP_ENCRYPTION_KEY_PREVIOUS`, then re-save keys / reconnect mailboxes.
- Nothing secret is stored in browser storage, public env vars (`NEXT_PUBLIC_*` is not used) or logs.

## Backup and restore

- In-app: **Imports & Exports → Exports & backup → Download full backup** (zip: one JSON file per table + stored files + manifest).
- CLI: `npm run backup` (writes `backups/…zip`).
- Restore into an **empty** database: `npm run restore -- path\to\backup.zip` (runs migrations first). Use the same `APP_ENCRYPTION_KEY`.
- In production also use the database provider's automated backups.

## Retention and deletion

- Nothing is deleted automatically. Message history, revisions, approvals, queue events and audit events are append-only.
- Disconnecting a mailbox removes its tokens and subscriptions, holds its pending sends and keeps history.
- Demo data can be removed with `npm run seed:demo -- --reset`.
- Import rollback removes only untouched records created by that import; anything with later work is kept and listed.
- To delete everything: drop the database and delete the storage folder/bucket.

## Graceful degradation

- Map tiles unavailable → list views remain usable with a message.
- Geocoder unavailable → approximate country-level pins; unresolved list on the map page.
- AI unavailable → manual exchange still works.
- Apollo restricted → CSV/manual workflows remain.
- Outlook expired/restricted → sends are held with the reason; schedules and content are kept.
