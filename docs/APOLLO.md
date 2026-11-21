# Apollo setup

Two independent paths; use either or both.

## A. CSV workflow (no API key needed)

1. In Apollo, export contacts to CSV.
2. **Imports & Exports → Upload**, kind **Apollo contact CSV export**.
3. Review the suggested column mapping (first/last/full name, title, seniority, company, website/domain, email, email status, verification date, person city/state/country, company city/state/country, LinkedIn URL, Apollo contact/person ID, Apollo account/organization ID). Apollo's export column names could not be confirmed from its help centre during this build, so every mapping is editable and saved for reuse.
4. Preview: companies are matched by domain (strong) or exact name (flagged to confirm); unresolved companies are listed and skipped.
5. Commit. Re-importing the same file is safe: contacts are deduplicated by Apollo ID, then by email; only empty fields are filled.

Email status is kept **verbatim** (`provider_status`). Only `verified` becomes *provider-verified*; catch-all/accept-all becomes *catch-all*; unverified, extrapolated, likely-to-engage, unavailable, etc. stay *unverified*. Provider verification is not a delivery guarantee. The person's location is stored on the contact and never overwrites the company's location.

## B. Direct API workflow

### Eligibility and key

- Apollo states all plans include basic API access, with advanced functionality on some plans; free accounts may need a work email for some search/enrichment actions. Creating API keys requires admin/permission.
- Some endpoints need a **master API key** or the endpoint in the key's scope (otherwise HTTP 403). The app shows *restricted* with the reason and keeps CSV/manual workflows available.
- Enter the key in **Settings → Apollo**. It is stored encrypted server-side and never sent to the browser. Use **Test** to run a single People Search request.
- Never rotate accounts or keys to get around restrictions.

### Endpoints used (verified against docs.apollo.io)

| Step | Endpoint | Credits |
| --- | --- | --- |
| People search by company domain + titles/seniorities | `POST /api/v1/mixed_people/api_search` | Documented as 0 credits; returns no email addresses (only a `has_email` flag) |
| Email enrichment of selected people | `POST /api/v1/people/match` (`reveal_personal_emails=false`, no phone reveal) | Charged only when credit-consuming data is found (1 credit for email/demographics per Apollo docs) |

A search hit — even with `has_email: true` — leaves the company **missing an email** until enrichment returns an actual address.

### Budgets and outcomes

- Batch search jobs: priority order, request budget, max candidates per company, pause/resume, cancel unstarted work, retry failures, respects `429` retry-after.
- Enrichment: only selected people; skips people who already have a usable address or were enriched in the last 30 days; per-run credit budget; actual credits recorded when Apollo reports them, otherwise labelled estimates.
- Distinct outcomes: match found, no match, insufficient info, auth error, access denied, timeout, rate limited, budget exhausted, email revealed, email not revealed. Only *no match* sets "no suitable match"; operational failures never do.

## Verification status

The REST adapter is implemented from current Apollo docs and tested through the interface with a deterministic mock. **It has not been run against a live Apollo account in this build.**
