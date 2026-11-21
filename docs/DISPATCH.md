# Dispatch state machine and recovery

Implementation: `src/domain/dispatch/states.ts`, `src/domain/dispatch/dispatcher.ts`. Tests: `tests/dispatch.test.ts`.

## States (`scheduled_sends.state`)

```
scheduled ──claim (CAS on state+version)──▶ dispatching ──HTTP 202──▶ submitted ──sent copy found──▶ recorded_sent
   │  ▲                                        │   │                     │
   │  └── throttled / pre-submission retry ────┘   ├─ timeout/crash after send request ─▶ uncertain ─reconcile─▶ recorded_sent
   │                                               │                                      └─ unresolved ─▶ owner decides
   ├─ pause ─▶ paused ─resume─▶ scheduled          ├─ terminal error ─▶ failed
   ├─ ineligible ─▶ held ─review/release─▶ scheduled
   ├─ cancel ─▶ cancelled
   └─ new revision ─▶ superseded
```

`dispatching` has phases persisted on the row: `claimed → draft_ready → send_requested → done`. They decide what is safe after a crash.

## What the dispatcher does for each due send

1. **Gates without claiming**: global pause → `paused`; planned time older than the missed-send grace window → `held` for review; mailbox limits/spacing/throttling → defer (`next_attempt_at`), never burst.
2. **Atomic claim**: `UPDATE … SET state='dispatching', lease_owner, lease_expires_at, version+1 WHERE id=? AND state='scheduled' AND version=?`. Only one worker can win. Edits, cancels and pauses use the same version CAS, so a stale row can never be claimed.
3. **Eligibility recheck under the claim** (and again immediately before sending): current revision = queued revision; approval not revoked and its content hash + mailbox match; campaign not paused; recipients not suppressed / bounced / invalid; company not suppressed or closed; no human reply from the company since scheduling (per coordination policy); enrollment active; for follow-ups, mailbox sync fresher than the configured limit and no reply in the thread; inside the sending window.
4. **Draft-first**: create (or reuse) a provider draft built from the immutable revision with the exact CV bytes (hash re-verified). The provider's change key after our last write is stored. If the existing draft's change key differs, it was **edited outside the app** → `held`; it is never sent under the older approval. A draft that is no longer a draft means it was already sent → reconcile, never resend.
5. **Cancellation cutoff**: re-read the row; if a cancel was requested, delete the draft and cancel. Then atomically set `phase='send_requested'` only if no cancel request exists.
6. **Submit**: `POST /me/messages/{id}/send`. HTTP 202 → `submitted` (acceptance evidence only). A reconcile job is queued.
7. **Reconcile**: look for the Sent Items copy (draft immutable ID, then `internetMessageId`). Found → `recorded_sent` with the provider's sent time. Mailbox sync also records sent copies.

## Errors

| Situation | Result |
| --- | --- |
| 429 / Retry-After | Back to `scheduled` with `next_attempt_at = now + Retry-After`; mailbox marked throttled. Safe: the request was refused. |
| Network failure / 5xx **before** the send request | Bounded exponential backoff (max 6 attempts) then `failed`. |
| Timeout / connection reset / 5xx **after** the send request | `uncertain`; reconcile before anything else. No blind resend. |
| 401 / revoked token | Mailbox → `expired`; send → `held` with schedule kept. |
| Tenant consent denied | Mailbox → `restricted` with instructions; sends held. |
| 4xx invalid request | `failed` (terminal, visible). |

## Crash and restart recovery

- Leases expire after 3 minutes. A send stuck in `dispatching`:
  - phase `claimed`/`draft_ready` → back to `scheduled` (safe, no provider send happened);
  - phase `send_requested` → `uncertain` + reconcile.
- All due work is read from the database; restarting web or worker loses nothing (tests 16, 17).

## Uncertain outcomes

Reconciliation retries with backoff. If it cannot establish the outcome, the send is flagged **needs decision** with three explicit choices: *mark sent* (you saw it in Sent Items), *retry the same draft* (an already-sent draft is detected and not resent), or *cancel*. A local idempotency key (`attempt_key`) is recorded for diagnostics but is **not** a provider-side deduplication guarantee. Exactly-once delivery is not promised.

## Evidence vocabulary

- **Planned** — the scheduled instant (not an arrival time).
- **Submitted** — the provider accepted the send request (HTTP 202). Not delivery.
- **Recorded sent** — a sent copy exists in the mailbox.
- **Bounced** — a delivery-failure notice was received later; the outreach attempt stays on record.

## Unavoidable race

There is always a short window between the last mailbox check and the provider accepting the send. A reply that arrives inside that window cannot stop that send. Follow-ups are additionally held when sync is older than the configured limit.
