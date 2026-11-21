# Architecture

## Processes

```
Browser (PWA) ──HTTPS──▶ web (Next.js: pages, server actions, route handlers)
                              │  reads/writes
                              ▼
                         PostgreSQL  ◀── worker (persistent loop: dispatch, reconcile,
                              ▲           mailbox sync, subscription renewal,
                              │           discovery batches, geocoding)
Microsoft Graph ──webhook──▶ web (records notification, enqueues sync; cloud only)
```

- **web** never sends mail or runs long jobs. It writes durable rows (scheduled sends, jobs) in the same transaction as the domain change.
- **worker** reads all due work from PostgreSQL every few seconds (`WORKER_TICK_MS`), heartbeats into `worker_heartbeats`, and is safe to run as several replicas.
- No browser timers, in-memory queues or long-lived web requests are used for scheduling.

## Choices and deviations

| Topic | Choice | Reason |
| --- | --- | --- |
| Queue | Own PostgreSQL tables (`scheduled_sends` with leases/phases + `jobs` outbox) instead of pg-boss | Dispatch needs a domain-specific state machine (phases, cancel-under-claim, reconciliation, version CAS) that a generic queue would duplicate; the same code runs on in-process PGlite for tests. Claims are single-statement compare-and-set updates with lease expiry. |
| ORM | Drizzle ORM + drizzle-kit migrations (`drizzle/`) | Type-safe, SQL-first, works with node-postgres and PGlite. |
| XLSX | Small zip+XML reader (`src/domain/import/xlsx.ts`, fflate + fast-xml-parser) | exceljs failed on the owner's workbook (absolute relationship targets); the registry SheetJS build is outdated. |
| Embedded DB | PGlite socket server for demo/dev | Docker was not available on the build machine; real PostgreSQL remains the supported runtime. |
| AI SDKs | Official `@anthropic-ai/sdk` and `openai` packages | Server-side only; models configurable. |
| Auth | Single owner, scrypt passphrase, hashed session tokens, httpOnly SameSite cookie | Private single-owner app; Server Actions are POST-only with Next's origin check; mutating route handlers check origin. |
| Map | MapLibre GL 6 with a configurable style URL (default OpenFreeMap) | Tiles and geocoding are separate, configurable services. |

## Code layout

```
src/db/            schema (all tables), client (node-postgres), pglite (tests)
src/domain/        provider-neutral business logic (tested without Next.js)
  import/          xlsx reader/writer, mapping, planner (match/merge rules), commit/rollback
  scheduling/      time rules (DST, windows, spreading), schedule/cancel/pause/resume
  dispatch/        state machine, dispatcher (claims, eligibility, send, reconcile)
  mail/            access (token refresh/health), sync (delta + ingestion), classify, subscriptions
  messages/        revisions, approvals, approval blockers
  discovery/       Apollo search/enrich/jobs/budgets, Apollo CSV import
  outreach/        personalisation (verified profile), sequences, follow-up pausing
  ai/              direct assistance with budgets, manual exchange export/import
  summary.ts       derived company summaries
  analytics.ts     metrics and response rates
src/providers/     mail (graph, graph-auth, mock), apollo (rest, mock), ai (anthropic, openai, mock)
src/server/        runtime wiring, auth, queries, import glue
src/app/           Next.js pages, server actions, route handlers
src/worker/        worker entry point
tests/             Vitest suites (in-process PostgreSQL via PGlite, FakeClock, mock providers)
```

## Data model (separate relational records)

- `owners`, `sessions`, `settings` (timezone, sending window, policies, heuristics)
- `companies` (+ `company_external_ids`, `company_locations`, `company_tags`, `company_evidence`) — original imported row kept in `source_row`; per-field provenance in `field_provenance` (import/manual/apollo, as-of date, sheet)
- `contacts` (person; `person_location` is never copied to company location), `email_addresses` (normalised; kind, source, quality, verbatim provider status, verification timestamps, bounce/suppression)
- `discovery_jobs`, `discovery_attempts` (provider, filters, status, outcome, candidates, credits actual vs estimated)
- `opportunities` (stage independent of outreach progress; unknown is valid)
- `campaigns`, `sequences`, `enrollments`
- `messages` + append-only `message_revisions` + `approvals` (bound to revision + content hash + mailbox)
- `scheduled_sends` (UTC instant + local intent + IANA zone + mode + DST resolution; state, phase, lease, version) + `dispatch_attempts` + append-only `queue_events`
- `mailboxes` (encrypted tokens, health, limits), `mailbox_folders` (per-folder delta cursors), `mailbox_subscriptions`, `webhook_notifications`, `conversations`
- `documents` + append-only `document_versions` (bytes in private storage, sha256)
- `templates`, `candidate_profile`, `tasks`, `import_batches`/`import_rows`/`column_mappings`/`duplicate_candidates`, `export_batches`, `saved_views`, `ai_jobs`, `ai_exchange_packages`/`ai_exchange_results`, `suppressions`, `audit_events`, `provider_credentials`, `usage_ledger`, `geocode_cache`, `jobs`, `worker_heartbeats`

Append-only is enforced by database triggers (`drizzle/0001_immutability.sql`).

## Independent status dimensions

| Dimension | Stored as |
| --- | --- |
| Contact discovery | `companies.discovery_status` (not_researched, searching, candidate_found, reviewed, no_suitable_match) |
| Discovery execution | `discovery_attempts.status` (pending, running, completed, failed, blocked_access, blocked_budget, cancelled) + `outcome` |
| Email availability / quality | derived from `email_addresses` (see below); `quality` = unknown / provider_verified / catch_all / invalid |
| Outreach progress | derived (see below) |
| Opportunity | `opportunities.stage` |
| Dispatch | `scheduled_sends.state` (+ `messages.status` mirror) |

Operational failures (timeouts, access denied, throttling, budget) never set `no_suitable_match`.

## Derived company summaries (`src/domain/summary.ts`)

- **Email available** = at least one address not suppressed, not hard-bounced, not invalid. A search hit or `has_email` flag is not an address.
- **Best quality** = provider_verified > catch_all > unknown. **Usable** = available and not an unverified AI guess.
- **Outreach progress** (first match wins): closed (company closed/suppressed or all opportunities closed) → interviewing (any opportunity in interview/offer) → replied (any human inbound reply) → contacted (any outbound recorded sent / submitted / sent from Outlook) → scheduled → ready (approved) → drafting → not contacted.
- The workbook's `Outreach_Status` is shown separately as "imported status" and never creates messages or evidence.
- Companies are counted distinctly from contacts and messages everywhere.

## Integration boundary for the separate CV app

CVs are uploaded as PDFs (`uploadCvVersion`). A future integration can push new versions by calling the same function (or an authenticated route wrapping it) with `documents.external_source` / `external_ref` set to the CV app's identifiers. Historical messages keep pointing to the exact `document_version` (bytes + sha256) they were approved with.
