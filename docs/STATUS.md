# Status: implemented, verified, and what still needs external setup

Legend: ✅ verified by automated tests (mock providers, injectable clock, in-process PostgreSQL) · 🖥️ verified manually in the browser against the local stack · 🔌 implemented, needs your credentials/infra for a live check · ⚠️ limitation.

## Acceptance scenarios

| # | Scenario | Status | Where |
| --- | --- | --- | --- |
| 1 | Multi-sheet workbook, inconsistent headers, mapping preview, correct counts | ✅ 🖥️ | `tests/import.test.ts`; real workbook via UI: 331 primary + 11 reserve + 1,874 leads = 2,216 companies, 133 promoted leads merged, 1,447 evidence rows |
| 2 | Reimport without duplicates or erasing later work | ✅ | import test (manual note kept, conflict choice, empty cells never erase); opt-in test with your workbook (`WORKBOOK_PATH`) |
| 3 | Ambiguous duplicates kept for review | ✅ | import test (name-only, shared-domain) + Duplicate review UI |
| 4 | Filter primary companies missing email in table and map | 🖥️ | shared filter bar; filters carry across Companies/Map/Contacts/Pipeline; saved views |
| 5 | Apollo CSV: company vs contact location, verbatim status | ✅ | `tests/integrations.test.ts` |
| 6 | Apollo search + enrich via real adapter; mock without credentials | ✅ (mock) 🔌 (live) | REST adapter per current docs; not run live |
| 7 | Search hit without address stays "missing email" | ✅ | integrations test |
| 8 | No match vs blocked vs timeout vs throttled vs budget | ✅ | integrations test |
| 9 | Draft from verified profile, specific CV version, approve exact revision | ✅ 🖥️ | dispatch test; UI flow draft → approve → schedule |
| 10 | Reviewed batch at recipient-local Monday 07:00 with preview and spacing | ✅ 🖥️ | time tests; batch preview page; demo seeds Shanghai/Los Angeles Monday 07:00 |
| 11 | Calendar, agenda, queue with both timezones | 🖥️ | Schedule & Queue |
| 12 | DST nonexistent/ambiguous resolved deterministically and visibly | ✅ | time tests; UI options |
| 13 | Edit approved content → old queued revision cannot dispatch | ✅ | dispatch test (even forcing the row back to scheduled) |
| 14 | Cancel/reschedule before dispatch, obsolete jobs don't send | ✅ | dispatch test |
| 15 | Cancellation cutoff under a concurrent claim | ✅ | dispatch test (simulated claim by another worker) |
| 16 | Restart web/worker, pending jobs and versions preserved | ✅ 🖥️ | lease-expiry test; worker killed and restarted on the live stack, schedules intact |
| 17 | Two workers never submit the same message | ✅ | dispatch test (two workers ticking concurrently; on PGlite their statements interleave on one connection — the guarantee comes from single-statement compare-and-set claims, which behave the same on PostgreSQL) |
| 18 | Timeout after possible acceptance → uncertain → reconcile without resend | ✅ 🖥️ | dispatch tests; the live worker reconciled the seeded uncertain send |
| 19 | Submitted ≠ recorded sent ≠ bounced | ✅ | dispatch test with delayed sent copy + bounce |
| 20 | Limits, Retry-After, pauses, overdue policy without bursts | ✅ | dispatch tests (hourly limit, 429, global pause, stale hold, re-spread) |
| 21 | Revoked mailbox holds sends without losing schedules | ✅ | dispatch test |
| 22 | Duplicate webhook/delta events, pagination, expired cursor | ✅ | integrations test (delta replay + paging + expiry); webhook dedupe implemented (unique key), not unit-tested |
| 23 | Reply matched to contact, follow-ups paused | ✅ | integrations test |
| 24 | Ambiguous reply kept in review, no domain-only merge | ✅ | integrations test |
| 25 | Follow-up blocked when sync stale, resumes after re-evaluation | ✅ | dispatch tests (incl. stays held if the hold outlived the grace window) |
| 26 | Bounce → replacement research, prior outreach kept | ✅ | dispatch/integrations tests |
| 27 | AI results: preview, reject stale/unknown, no auto approval/sending | ✅ | integrations test |
| 28 | Replace CV, original bytes kept on historical messages | ✅ | integrations test (+ DB trigger rejects edits) |
| 29 | Unauthenticated user blocked from records and downloads | 🖥️ | verified with HTTP requests: pages redirect to login; files/backup/exports return 401 without or with a forged session |
| 30 | Full flow without credentials | ✅ 🖥️ | `tests/demo.test.ts` + demo mode in the browser |

Browser suite (`npm run test:e2e`, Playwright, 15 tests, all passing) runs the real production build, worker and an isolated in-memory database: sign-in/sign-out and unauthenticated access, all 12 sections with one heading, labelled controls, no console errors and a working skip link, company filter carried to the map + saved view, map legend and discovery mode, placeholder blocking approval, approve & send now through the worker to a recorded sent copy, edit-after-approval superseding the queued send, workbook upload → preview → commit → safe reimport, batch scheduling at recipient-local Monday 07:00, manual reply categorisation, global pause banner.

The browser suite caught a production bug the unit tests could not (their fake clock returns the same instant on every read): the mailbox rate gate treated "allowed now" as a deferral, so with a real clock no message would have been sent. Fixed, with a regression test.

Also tested: backup → restore round trip into an empty database (`tests/demo.test.ts`), import rollback with dependencies.

## Gmail adapter

✅ 7 tests (`tests/gmail.test.ts`) run the real dispatcher, reconciliation and sync against a fake Gmail API that follows Google's documented behaviour: draft-first send with the exact CV, sent copy found via the thread (new message ID), no duplicate on sync, reply matched by In-Reply-To and the app's reply threaded, network drop after send → uncertain → reconciled without resend, draft edited in Gmail → held, history paging and expired history (404) → resync without duplicates, revoked token → mailbox expired and send held. 🔌 Not yet run against a real Gmail account.

## External setup required for live use

- 🔌 **Gmail**: Google Cloud project with the Gmail API enabled, OAuth consent screen (Personal user type), Web OAuth client with the localhost redirect URI (docs/GMAIL.md).

- 🔌 **Outlook (alternative)**: Microsoft now requires an Entra directory (e.g. via an Azure free account) to register an app; then app registration, client secret, redirect URI, consent (docs/OUTLOOK.md). The Graph adapter has not been run against a live mailbox in this build — use docs/LIVE-TEST-CHECKLIST.md with an address you own.
- 🔌 **Apollo**: API key with People Search/Enrichment in scope (master key may be required). Not run live.
- 🔌 **Anthropic/OpenAI**: API keys and (for OpenAI) a model ID. Not run live.
- 🔌 **Geocoder**: `GEOCODER=nominatim` (own instance or within the public usage policy) for city-level pins; otherwise approximate country pins.
- 🔌 **S3-compatible storage** for cloud: SigV4 adapter implemented but not run against a real bucket.
- 🔌 **Cloud deployment + webhooks**: needs a host running web and worker continuously with HTTPS (docs/DEPLOYMENT.md).
- 🔌 **Docker Compose**: files provided; Docker was not installed on the build machine, so `docker compose up` was not executed here.

## Known limitations

- ⚠️ Outlook attachments over 3 MB are rejected (upload sessions not implemented).
- ⚠️ The delta `$select` does not include `internetMessageHeaders`; reply matching uses our internet message IDs, provider conversation IDs and exact sender addresses. A header fetch for unmatched mail exists in the adapter but is not wired in.
- ⚠️ No holiday calendar: sending windows know weekdays and hours only.
- ⚠️ Recipient timezone suggestions use a small city table; multi-zone countries without a known city require you to choose.
- ⚠️ Reply categories are rule-based suggestions (optionally AI); review before acting.
- ⚠️ The embedded PGlite database is for demo/development only.
- ⚠️ Single owner; no multi-user roles.
- ⚠️ Apollo CSV column names could not be confirmed from Apollo's help centre (403); mappings are suggested from common names and are editable.
- ⚠️ Analytics attribute each company to its first sent message in the window; small samples are flagged and differences are not causal.
