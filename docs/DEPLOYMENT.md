# Cloud deployment

Goal: scheduled sends and mail sync continue while your PC is off. That requires **two always-running processes** (web and worker) plus PostgreSQL and private file storage. A generic serverless deployment of the web app alone is **not** sufficient — it does not run the persistent worker.

## Topology

```
          HTTPS (TLS)                       private network
Internet ───────────▶ web (Next.js, ≥1 instance) ─┐
                                                   ├──▶ PostgreSQL (managed, daily backups)
                     worker (1+ instances, always on)┘
                           │
                           └──▶ S3-compatible private bucket (CVs, uploaded imports)
```

Any host that runs long-lived containers works, for example: a small VPS running `docker compose` behind Caddy/nginx with automatic TLS; Fly.io / Render / Railway style platforms with a "web service" and a "background worker" from the same image; or Azure Container Apps / AWS ECS with two services. Choose one where the worker is a separate always-on service (not scale-to-zero).

## Steps

1. Build the image from the `Dockerfile` (one image; web runs `npm run start`, worker runs `npm run worker`).
2. Provision PostgreSQL 16+ with automated daily backups and point-in-time recovery if available. Set `DATABASE_URL` (and `DATABASE_SSL=require` if the provider requires TLS).
3. Run migrations once per release: `npm run db:migrate` (a release/predeploy command, or the `migrate` service in Compose).
4. Storage: set `STORAGE_DRIVER=s3` with a **private** bucket (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`). Never make it public; downloads go through authenticated routes.
5. Secrets: `APP_ENCRYPTION_KEY`, `MS_CLIENT_SECRET`, database password, S3 keys in the platform's secret manager — not in the image or repository.
6. HTTPS: required in production (secure cookies, OAuth redirect, webhooks). Set `APP_BASE_URL=https://your-domain`, add `https://your-domain/api/oauth/microsoft/callback` to the app registration and `MS_REDIRECT_URI`.
7. Webhooks: `WEBHOOKS_ENABLED=1`, `PUBLIC_BASE_URL=https://your-domain`. The worker renews subscriptions automatically; if renewal fails it falls back to polling and logs the error.
8. Scale: one web instance and one worker instance are enough. Extra workers are safe (claims are atomic) but unnecessary.

## Monitoring

- `GET /api/health` (no private data): database up + worker heartbeat age. Alert if `workerHeartbeatAgeSeconds` > 120 or the endpoint fails.
- The app shows worker heartbeat, next due send, queue counts, mailbox health/last sync and failed/uncertain sends (Schedule & Queue).
- Logs redact tokens, keys and email addresses.

## Ongoing costs (no prices invented)

Expect recurring charges for: the container host (web + always-on worker), managed PostgreSQL and its backups, object storage, a domain name, and optionally map tiles/geocoding beyond free tiers, Apollo plan/credits and AI API usage. Microsoft Graph delegated mail access for your own mailbox has no separate Graph fee. Check each provider's current pricing page before choosing.
