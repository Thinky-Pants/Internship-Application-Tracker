# Scheduling and timezone rules

Implementation: `src/domain/scheduling/time.ts`, `src/domain/scheduling/service.ts`. Tests: `tests/scheduling-time.test.ts`, `tests/dispatch.test.ts`.

## What is stored

Every schedule stores the **UTC instant** plus the **original intent**: local wall time (`2027-01-11T07:00`), **IANA zone**, **mode** (`recipient_local` or `my_local`) and any **DST resolution**. The interpretation is always explicit; the UI asks which mode you mean.

- **Display timezone** defaults to `Asia/Riyadh` (Settings). The calendar, agenda, queue and detail panel show both your time and the schedule's own zone.
- **Recipient timezone** is suggested from the company's primary office (city table → single-zone country). Multi-zone countries without a recognised city (e.g. United States, Canada, Australia, Indonesia) are flagged and you must choose. It is always editable.

## DST

- **Nonexistent local time** (spring-forward gap, e.g. 02:30 on the day clocks jump): rejected with an explanation and two concrete options — *first valid time after the change* (03:00) or *shift by the gap* (03:30).
- **Ambiguous local time** (fall-back overlap, e.g. 01:30 when clocks go back): rejected with two options — *first occurrence* (earlier offset) or *second occurrence* (later offset).
- Resolutions are deterministic and recorded on the schedule.

## Next eligible date

- "Next Monday at 07:00" = the first Monday strictly after now **in each recipient's zone**.
- **Sending window** (days + start/end) is evaluated in the schedule's zone. If the instant falls outside, it moves to the start of the next allowed day's window (or later the same day if before the start). Window starts in a DST gap use the first valid minute after the gap.
- **Holidays are not considered** — no holiday calendar source is configured.

## Batch spreading

`planBatch` assigns times per mailbox, in order of desired time, respecting:

- minimum spacing between sends,
- a rolling hourly limit,
- a daily limit (days bucketed in your display zone),
- each item's sending window,
- already-planned sends for the same mailbox.

Limits are **your** conservative per-mailbox settings; provider limits differ by account and are not hard-coded. The preview shows each message's requested local time, planned time in the recipient's zone and yours, the shift and why. "Planned send time" is never presented as an arrival time.

## Edits, reschedules, approvals

- Editing subject, body, recipients, mailbox or attachments creates a new revision, revokes the approval and supersedes queued sends of the old revision (version CAS — if a worker already claimed it, the edit is refused).
- Rescheduling keeps the approval only when content and recipients are unchanged and the "keep approval when only the time changes" policy is on; otherwise the old schedule is superseded and re-approval is required. The UI states the effect before saving.

## Pauses and overdue work

- Global pause and campaign pause stop claims; due sends move to `paused`.
- **Missed-send grace window** (default 120 min): on resume, or when the worker finds overdue work, items younger than the window are re-spread from *now* through the limits; older items are **held for review**. No backlog burst is ever released.
- "Release held after review" re-plans selected items from now, still through the limits.

## App-owned queue

Microsoft Graph has no general-purpose delayed-send endpoint that this app relies on; the app owns the queue. Messages scheduled inside Outlook itself are not visible to this app unless they appear in synced folders after sending.
