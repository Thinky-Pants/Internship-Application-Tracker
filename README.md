# Internship Outreach Manager

A private, single-owner web app (installable on Windows as a PWA) for running an international internship outreach campaign: import your company workbook, find contacts and email addresses, draft and approve exact messages, schedule them in the recipient's or your own timezone, send through **Gmail** (Gmail API) or **Outlook** (Microsoft Graph) from a persistent worker, and track replies, follow-ups and next actions.

**Stack:** TypeScript · Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · PostgreSQL + Drizzle ORM · a dedicated worker process with a PostgreSQL-backed durable queue · MapLibre GL · Gmail API / Microsoft Graph · Apollo REST + CSV · optional Anthropic/OpenAI · Vitest + Playwright.

> **Background work only happens while the worker runs.** On your PC that means while `npm run worker` (or the Docker `worker` service) is running. To keep scheduled sends and sync going with your PC off, deploy web + worker + PostgreSQL to a host that keeps both processes running — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quick start (Windows, PowerShell)

Prerequisites: **Node.js 22 LTS** and either **Docker Desktop** or the **PostgreSQL 16+ Windows installer**. Details: [docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md).

```powershell
npm install
```

```powershell
Copy-Item .env.example .env
```

Generate an encryption key and paste it into `APP_ENCRYPTION_KEY` in `.env`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Option A — Docker Compose (web + worker + PostgreSQL)

```powershell
docker compose up -d --build
```

Open http://localhost:3000 and create the owner account.

### Option B — Local processes with your own PostgreSQL

Set `DATABASE_URL` in `.env`, then:

```powershell
npm run db:migrate
```

```powershell
npm run dev
```

In a second terminal (keep it running — this is what sends scheduled mail and syncs Outlook):

```powershell
npm run worker
```

### Option C — Zero-install demo (embedded database, mock providers)

Set `DEMO_MODE=1`, `DEMO_PASSWORD=<12+ chars>` and `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable` in `.env`, then run each in its own terminal:

```powershell
npm run db:local
```

```powershell
npm run db:migrate; npm run seed:demo; npm run dev
```

```powershell
npm run worker
```

Demo mode uses the mock mailbox, mock Apollo and mock AI only; it never sends real email or spends credits. The embedded database is for demo/development only (see the limitation in docs/SETUP-WINDOWS.md).

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Start web (dev) | `npm run dev` |
| Build / start web (production) | `npm run build` then `npm run start` |
| Start worker | `npm run worker` |
| Apply migrations | `npm run db:migrate` |
| Generate a migration after schema edits | `npm run db:generate` |
| Seed / reset demo data | `npm run seed:demo` / `npm run seed:demo -- --reset` |
| Tests | `npm test` (add `$env:WORKBOOK_PATH="C:\path\to\workbook.xlsx"` to include your real workbook) |
| Browser tests (builds, starts an isolated in-memory stack, uses installed Edge) | `npm run test:e2e` (set `$env:E2E_BROWSER_CHANNEL="chrome"` to use Chrome) |
| Typecheck | `npm run typecheck` |
| Backup (DB + files → zip) | `npm run backup` |
| Restore into an empty DB | `npm run restore -- path\to\backup.zip` |
| Embedded dev database | `npm run db:local` |

## Install as a Windows app

Open the app in Microsoft Edge (or Chrome) → **⋯ → Apps → Install this site as an app**. It then appears in the Start menu and can be pinned to the taskbar, opening in its own window. The service worker caches only the static app shell; mailbox data, attachments and API responses are never cached, and sending/scheduling is disabled while offline.

## Documentation

- [docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md) — prerequisites and first run
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, choices/deviations, data model, derived-status rules
- [docs/DISPATCH.md](docs/DISPATCH.md) — dispatch state machine, cancellation cutoff, recovery, uncertain sends
- [docs/SCHEDULING.md](docs/SCHEDULING.md) — timezone, DST, sending windows, batch spreading, overdue policy
- [docs/SYNC.md](docs/SYNC.md) — Outlook sync coverage, threading, reply handling, follow-up pausing
- [docs/GMAIL.md](docs/GMAIL.md) — Gmail: Google Cloud project, Personal OAuth app, connect
- [docs/OUTLOOK.md](docs/OUTLOOK.md) — Outlook (alternative): Microsoft app registration, permissions, consent, webhooks, polling
- [docs/APOLLO.md](docs/APOLLO.md) — Apollo eligibility, API key, CSV import
- [docs/AI.md](docs/AI.md) — optional AI providers and the manual AI exchange format
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — cloud topology, worker uptime, storage, HTTPS, backups, costs
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — security, secrets, backup/restore, retention/deletion
- [docs/LIVE-TEST-CHECKLIST.md](docs/LIVE-TEST-CHECKLIST.md) — opt-in live integration checklist
- [docs/STATUS.md](docs/STATUS.md) — implemented / verified / external-setup-required, and known limitations
- [samples/](samples/) — workbook/CSV template and AI exchange sample
