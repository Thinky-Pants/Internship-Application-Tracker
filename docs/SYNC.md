# Mailbox sync, threading and replies

Implementation: `src/domain/mail/sync.ts`, `classify.ts`, `subscriptions.ts`, `src/providers/mail/graph.ts`. Tests: `tests/integrations.test.ts`.

## Coverage

- Folders are discovered on connect. **Inbox** and **Sent Items** are tracked by default; any other folder (e.g. one your mail rules move recruiter replies into) can be tracked in Settings → Outlook → Folders. The Inbox page shows coverage and last successful sync per folder.
- **Initial sync scope**: only messages received in the last `initial_sync_days` (default 90, configurable) via `$filter=receivedDateTime ge …`. The whole mailbox is never fetched.
- **Unrelated mail is not stored.** A message is stored only when it is ours, replies to ours, comes from/goes to a known address, or its sender domain matches a company (kept for review).

## Delta mechanics (per folder)

- `GET /me/mailFolders/{id}/messages/delta`; follow `@odata.nextLink` pages until `@odata.deltaLink`; save the delta link only after the round completes. A crash replays the round; duplicates are ignored by the unique `(mailbox, provider message id)` key.
- Expired cursor (`410` / `syncStateNotFound`) → bounded resync from the initial window; deduplication prevents duplicates.
- `@removed` items keep our record (history) and clear the folder reference.
- All Graph requests send `Prefer: IdType="ImmutableId"`.

## Modes

- **Local / no public URL**: the worker polls every `SYNC_POLL_MINUTES` (default 5) and on demand ("Sync now").
- **Cloud**: `WEBHOOKS_ENABLED=1` + HTTPS `PUBLIC_BASE_URL`. Subscriptions per tracked folder (renewed at ~4 days, below the 10,080-minute maximum), `clientState` verified against a stored hash, lifecycle events handled (`reauthorizationRequired` → renew, `subscriptionRemoved` → recreate, `missed` → resync), notifications acknowledged with 202 immediately and deduplicated; they only trigger a delta sync. A 30-minute safety poll still runs.

## Thread matching (deterministic)

1. `In-Reply-To` / `References` contain one of our `internetMessageId`s.
2. Same provider `conversationId` as one of our outbound messages in this mailbox.
3. Sender address exactly matches a known email address (company/contact).
4. Sender **domain** matches a company → stored but **ambiguous**: a separate conversation flagged for review; never merged by domain alone. You assign it manually.

## Reply categories

Rules suggest: positive interest, question/request, referral, rejection, out-of-office, automated acknowledgement, unsubscribe/do-not-contact, bounce, uncertain. AI can add a suggestion. **Manual choices always win** and are never overwritten.

## Effects of incoming mail

- **Bounce** → the address is marked hard-bounced, the original outbound message is flagged bounced (the attempt stays on record), the contact's pending follow-ups pause, and a "research a replacement contact" task is created.
- **Out-of-office** → pending follow-ups for that contact pause and a task asks you to pick a new date (no automatic extension from extracted text).
- **Automated acknowledgement** → no change.
- **Any human reply (including uncertain)** → pending sends pause per the **company coordination policy** (Settings: pause everyone at the company, or only that contact), the enrollment stops, and a "decide next step" task is created. A reply is not automatically a positive opportunity.
- **Unsubscribe** → the address is suppressed immediately (conservative), flagged for your review.

## Sent outside the app

Messages you send from Outlook to a known address are recorded as `external_outlook` evidence and count as "contacted".

## Follow-ups

Follow-up delays anchor to the previous message's **recorded sent** time. Follow-ups are in-thread reply drafts (`createReply`) that need approval. Before dispatch they are held if the mailbox sync is older than the configured limit and re-evaluated after the next successful sync; if the hold outlived the missed-send grace window they stay held for review.
