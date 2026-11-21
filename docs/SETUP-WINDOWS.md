# Windows setup

## Prerequisites

1. **Node.js 22 LTS** — https://nodejs.org (the installer adds `node` and `npm` to PATH). Check with `node --version`.
2. **A PostgreSQL database**, one of:
   - **Docker Desktop** (https://www.docker.com/products/docker-desktop/) — runs PostgreSQL, web and worker with `docker compose up -d --build`. Requires WSL 2 (the installer guides you).
   - **PostgreSQL for Windows** (https://www.postgresql.org/download/windows/, version 16 or newer). Create a database `outreach` and set `DATABASE_URL=postgres://postgres:<password>@localhost:5432/outreach` in `.env`.
   - **Embedded database (demo/dev only)** — `npm run db:local` starts PGlite (PostgreSQL compiled to WebAssembly) on port 54329, storing data in `.\data\pglite`. No install needed. **Limitation:** PGlite is a single database connection multiplexed between the web app and worker, so concurrent transactions are serialised and isolation is weaker than a real server. The dispatcher's critical claims are single-statement compare-and-set updates and remain safe, but use real PostgreSQL before sending real email.
3. **Microsoft Edge or Chrome** for installing the PWA.

## First run

```powershell
npm install
```

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

- `DATABASE_URL` — see above.
- `APP_ENCRYPTION_KEY` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Store a copy in your password manager; without it, stored tokens/API keys cannot be decrypted.
- Leave Microsoft/Apollo/AI settings empty for now; they are optional.

```powershell
npm run db:migrate
```

```powershell
npm run dev
```

```powershell
npm run worker
```

Open http://localhost:3000 → **Set up owner access** → then follow the first-run checklist on the Settings page:

1. Display timezone (default Asia/Riyadh) and sending window.
2. **Imports & Exports → Upload** your workbook. Review sheet roles (Companies = primary, Reserves = reserve, Leads = lead, Sources = research evidence; summary/log/dictionary sheets are ignored), column mappings, then the preview; commit.
3. Map tiles work out of the box (OpenFreeMap). Geocoding defaults to approximate country-level pins; configure `GEOCODER` for city-level pins.
4. Optional: Apollo API key, Anthropic/OpenAI keys.
5. Outlook: register the app (docs/OUTLOOK.md) and click **Connect Outlook account** — or add a **mock mailbox** to practise.
6. **CVs & Templates**: upload CV PDFs, write templates, fill in and confirm your verified profile.

## Running continuously on Windows

The worker must be running for scheduled sends and mail sync. Options:

- Keep `npm run worker` open in a terminal, or
- Docker Desktop with `restart: unless-stopped` (already set) and "Start Docker Desktop when you sign in", or
- Deploy to the cloud (docs/DEPLOYMENT.md) so work continues with your PC off.

If your PC sleeps or the worker stops, sends that become overdue are handled by the missed-send policy: recent ones are spread out through your limits; ones older than the grace window are held for your review, never sent as a burst.

## Troubleshooting

- **"The background worker is not running"** banner — start `npm run worker`.
- **Map tiles do not load** — the list view still works. Check Settings → Map tiles (style URL) and your network.
- **Outlook "restricted"** — your organisation blocks user consent; see docs/OUTLOOK.md.
- **Upload says ".xls not supported"** — save the workbook as `.xlsx`.
