# Opt-in live integration checklist

Run only with addresses **you own** (e.g. a second personal mailbox). Never use real campaign contacts for testing. Use real PostgreSQL, `DEMO_MODE=0`.

## Gmail

- [ ] Google Cloud project, Gmail API enabled, Personal OAuth app, Web client (docs/GMAIL.md); `.env` has `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`; containers recreated.
- [ ] Settings → Connect Gmail account → **connected**, correct address, Inbox/Sent/labels discovered.
- [ ] Create a company + contact using a second address you own; draft → approve → schedule 3 minutes ahead (worker running).
- [ ] Queue: *dispatching* → *submitted* → **recorded sent**; Gmail Sent shows the message with the CV attached; your test inbox receives it.
- [ ] Reply from the test address → after sync (≤5 min or Sync now) the reply appears in the same conversation; pending follow-ups paused.
- [ ] Reply in thread from the app → arrives in the same Gmail thread.
- [ ] Disconnect → pending sends held; access gone from myaccount.google.com/permissions; reconnect → resume.

## Outlook (alternative)

- [ ] App registered (docs/OUTLOOK.md); `.env` has `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REDIRECT_URI`.
- [ ] Settings → Connect Outlook → mailbox shows **connected**, correct address, folders discovered.
- [ ] Inbox → Sync now → last sync time updates; only linked mail appears.
- [ ] Create a company with domain of your test mailbox and a contact with your test address.
- [ ] Draft → approve → schedule 3 minutes ahead (my timezone). Worker running.
- [ ] Queue shows *dispatching* → *submitted*; your Outlook Drafts briefly contains the draft; it moves to Sent Items.
- [ ] Within a minute or two the send shows **recorded sent** with the Sent Items timestamp.
- [ ] Reply from the test mailbox → after sync the reply appears in the same conversation, category suggested, pending follow-ups paused.
- [ ] Reply in thread from the app → arrives in the same thread in your test mailbox.
- [ ] Edit a scheduled draft in Outlook (if you open it there before dispatch) → the app holds it as "changed outside this app".
- [ ] Disconnect → pending sends become *held*; reconnect → resume.
- [ ] (Cloud) Webhooks: subscription created; replies sync within seconds; `/api/health` OK.

## Apollo

- [ ] Settings → Apollo key saved → **Test** succeeds or shows the precise restriction.
- [ ] Company page → Search people (0-credit search) → candidates listed, company still "missing email".
- [ ] Enrich one person with budget 1 → address stored with verbatim status; credits recorded as actual or estimate.
- [ ] Re-enrich the same person → skipped (already resolved).

## AI (optional)

- [ ] Settings → key + model → Draft with AI produces an unapproved draft; usage recorded.
- [ ] Manual exchange: export → paste into a chat tool → import → preview → accept one.

## Recovery

- [ ] Stop the worker while a send is due; restart → recent overdue sends spread out; old ones held.
- [ ] Backup → restore into a fresh database → data and CV files present.
