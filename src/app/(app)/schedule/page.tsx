import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { queueCounts } from "@/domain/scheduling/service";
import { STATE_LABEL, type SendState } from "@/domain/dispatch/states";
import { Badge, Button, Field, fmtDate, Notice, PageHeader, Section, Stat, StateBadge } from "@/components/ui";
import { Flash } from "@/components/flash";
import { cancelSendAction, pauseSendAction, resumeSendAction, rescheduleAction, resolveUncertainAction, globalPauseAction, campaignPauseAction, createCampaignAction, releaseHeldAction } from "@/app/actions/drafts";
import type { AttachmentRef } from "@/domain/messages/compose";

export const metadata = { title: "Schedule & Queue" };
const STATES: SendState[] = ["scheduled", "held", "paused", "dispatching", "submitted", "uncertain", "failed", "recorded_sent", "cancelled", "superseded"];

export default async function SchedulePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const zone = st.displayTimezone;
  const now = new Date();
  const view = sp.view ?? "month";
  const anchor = sp.at ? DateTime.fromISO(sp.at, { zone }) : DateTime.fromJSDate(now, { zone });

  const [sends, mailboxes, campaigns, counts, beats, nextJob] = await Promise.all([
    db.select({ sd: s.scheduledSends, m: s.messages, co: s.companies }).from(s.scheduledSends).innerJoin(s.messages, eq(s.messages.id, s.scheduledSends.messageId)).leftJoin(s.companies, eq(s.companies.id, s.messages.companyId)).where(eq(s.scheduledSends.ownerId, owner.id)).orderBy(s.scheduledSends.plannedAt),
    db.select().from(s.mailboxes).where(eq(s.mailboxes.ownerId, owner.id)),
    db.select().from(s.campaigns).where(eq(s.campaigns.ownerId, owner.id)),
    queueCounts(db, owner.id, now, zone),
    db.select().from(s.workerHeartbeats).orderBy(desc(s.workerHeartbeats.lastBeatAt)),
    db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.ownerId, owner.id), eq(s.scheduledSends.state, "scheduled"))).orderBy(s.scheduledSends.plannedAt).limit(1),
  ]);

  // Filters
  const fState = sp.state;
  const fMailbox = sp.mailbox;
  const fCampaign = sp.campaign;
  const fPriority = sp.priority;
  const fCountry = sp.country;
  const fromD = sp.from ? new Date(sp.from) : null;
  const toD = sp.to ? new Date(sp.to + "T23:59:59Z") : null;
  const filtered = sends.filter(({ sd, co }) =>
    (!fState || sd.state === fState) && (!fMailbox || sd.mailboxId === fMailbox) && (!fCampaign || sd.campaignId === fCampaign) &&
    (!fPriority || co?.priority === fPriority) && (!fCountry || co?.country === fCountry) && (!fromD || sd.plannedAt >= fromD) && (!toD || sd.plannedAt <= toD));
  const sort = sp.sort ?? "planned";
  const sorted = [...filtered].sort((a, b) => sort === "state" ? a.sd.state.localeCompare(b.sd.state) : sort === "company" ? (a.co?.name ?? "").localeCompare(b.co?.name ?? "") : a.sd.plannedAt.getTime() - b.sd.plannedAt.getTime());
  const selected = sp.send ? sends.find((x) => x.sd.id === sp.send) : undefined;
  const qs = (extra: Record<string, string>) => "?" + new URLSearchParams({ ...Object.fromEntries(Object.entries(sp).filter(([k]) => !["msg", "err"].includes(k))), ...extra }).toString();
  const mbLabel = (id: string) => mailboxes.find((m) => m.id === id)?.emailAddress ?? "mailbox";
  const beatAge = beats[0] ? Math.round((now.getTime() - beats[0].lastBeatAt.getTime()) / 1000) : null;
  const countries = [...new Set(sends.map((x) => x.co?.country).filter(Boolean) as string[])].sort();

  return (
    <>
      <PageHeader title="Schedule & Queue" subtitle={`Times shown in your timezone (${zone}) and the schedule’s own timezone. These are planned send times, not arrival times.`}
        actions={<form action={globalPauseAction} className="flex items-center gap-1"><input type="hidden" name="on" value={st.globalPause ? "0" : "1"} />{!st.globalPause && <input name="reason" placeholder="Reason (optional)" aria-label="Pause reason" className="w-40" />}<Button variant={st.globalPause ? "primary" : "danger"} type="submit">{st.globalPause ? "Lift global pause" : "Pause all sending"}</Button></form>} />
      <Flash sp={sp} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Stat label="Today" value={counts.today} href={`/schedule${qs({ state: "scheduled" })}`} />
        <Stat label="Tomorrow" value={counts.tomorrow} />
        <Stat label="This week" value={counts.thisWeek} />
        <Stat label="Overdue" value={counts.overdue} hint="planned time passed" />
        <Stat label="Paused" value={counts.paused} href={`/schedule${qs({ state: "paused" })}`} />
        <Stat label="Held" value={counts.held} href={`/schedule${qs({ state: "held" })}`} />
        <Stat label="Failed" value={counts.failed} href={`/schedule${qs({ state: "failed" })}`} />
        <Stat label="Uncertain" value={counts.uncertain} href={`/schedule${qs({ state: "uncertain" })}`} />
      </div>
      <div className="mb-3 grid gap-3 md:grid-cols-3">
        <Section title="Worker & queue health">
          <ul className="text-[13px]">
            <li>Worker: {beatAge == null ? <Badge tone="danger">not running</Badge> : beatAge < 60 ? <Badge tone="ok">heartbeat {beatAge}s ago</Badge> : <Badge tone="danger">silent {beatAge}s</Badge>} ({beats.length} registered)</li>
            <li>Next due: {nextJob[0] ? `${fmtDate(nextJob[0].plannedAt, zone)}` : "nothing scheduled"}</li>
            {mailboxes.map((m) => <li key={m.id}>{m.emailAddress ?? m.provider}: <Badge tone={m.status === "connected" ? "ok" : "danger"}>{m.status}</Badge> · last sync {m.lastSyncAt ? `${Math.round((now.getTime() - m.lastSyncAt.getTime()) / 60000)} min ago` : "never"} · limits {m.dailyLimit}/day, {m.hourlyLimit}/h, ≥{m.minSpacingSeconds}s apart{m.throttledUntil && m.throttledUntil > now ? ` · throttled until ${fmtDate(m.throttledUntil, zone)}` : ""}</li>)}
          </ul>
          <p className="mt-2 text-[11px] text-muted">Overdue sends younger than {st.missedSendGraceMinutes} min are spread through limits; older ones are held for review instead of sending a backlog.</p>
        </Section>
        <Section title="Campaigns">
          {campaigns.map((c) => <form key={c.id} action={campaignPauseAction} className="mb-1 flex items-center gap-2 text-[13px]"><input type="hidden" name="campaignId" value={c.id} /><input type="hidden" name="on" value={c.paused ? "0" : "1"} /><span>{c.name}</span>{c.paused && <Badge tone="warn">paused</Badge>}<Button type="submit">{c.paused ? "Resume" : "Pause"}</Button></form>)}
          <form action={createCampaignAction} className="mt-1 flex gap-1"><input type="hidden" name="back" value="/schedule" /><input name="name" placeholder="New campaign" aria-label="New campaign name" required /><Button type="submit">Add</Button></form>
        </Section>
        <Section title="Cancellation cutoff">
          <p className="text-[12px]">Before a worker’s atomic claim, cancel is guaranteed. After the claim and before the provider send request, a cancel request is honoured. Once the request to Outlook is underway, cancellation is best effort — Outlook has no reliable recall and this app does not claim one.</p>
        </Section>
      </div>

      <form method="get" className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-2" aria-label="Filter queue">
        <input type="hidden" name="view" value={view} />
        <Field label="From" htmlFor="q-from"><input id="q-from" type="date" name="from" defaultValue={sp.from} /></Field>
        <Field label="To" htmlFor="q-to"><input id="q-to" type="date" name="to" defaultValue={sp.to} /></Field>
        <Field label="Status" htmlFor="q-st"><select id="q-st" name="state" defaultValue={fState ?? ""}><option value="">Any</option>{STATES.map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
        <Field label="Mailbox" htmlFor="q-mb"><select id="q-mb" name="mailbox" defaultValue={fMailbox ?? ""}><option value="">Any</option>{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.emailAddress}</option>)}</select></Field>
        <Field label="Campaign" htmlFor="q-c"><select id="q-c" name="campaign" defaultValue={fCampaign ?? ""}><option value="">Any</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Priority" htmlFor="q-p"><select id="q-p" name="priority" defaultValue={fPriority ?? ""}><option value="">Any</option>{["primary", "reserve", "lead", "other"].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Country" htmlFor="q-co"><select id="q-co" name="country" defaultValue={fCountry ?? ""}><option value="">Any</option>{countries.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Button type="submit">Filter</Button>
        <span className="ml-auto flex gap-1">{["month", "week", "agenda", "queue"].map((v) => <Link key={v} href={`/schedule${qs({ view: v })}`} aria-current={view === v ? "page" : undefined} className={`rounded px-2 py-1 text-[13px] no-underline ${view === v ? "bg-surface-2 font-semibold text-fg" : "text-muted"}`}>{v}</Link>)}</span>
      </form>

      <div className="grid gap-3 xl:grid-cols-[1fr_380px]">
        <div>
          {(view === "month" || view === "week") && <Calendar view={view} anchor={anchor} zone={zone} items={filtered} qs={qs} />}
          {view === "agenda" && (
            <Section title="Agenda">
              {groupByDay(sorted, zone).map(([day, items]) => (
                <div key={day} className="mb-2"><h3 className="text-[13px] font-semibold">{day}</h3>
                  <ul className="text-[13px]">{items.map(({ sd, m, co }) => <li key={sd.id}><Link href={qs({ send: sd.id })}>{fmtDate(sd.plannedAt, zone).slice(-5)} (you) · {fmtDate(sd.plannedAt, sd.intentZone).slice(-5)} {sd.intentZone}</Link> — {co?.name ?? "—"}: {m.subject} <StateBadge state={sd.state} /></li>)}</ul></div>
              ))}
            </Section>
          )}
          {view === "queue" && (
            <Section title={`Queue (${sorted.length})`} actions={<span className="text-[12px]">Sort: {["planned", "state", "company"].map((x) => <Link key={x} href={`/schedule${qs({ sort: x })}`} className="ml-1">{x}</Link>)}</span>}>
              <form>
                <table className="data">
                  <thead><tr><th><span className="sr-only">Select</span></th><th>Planned (you)</th><th>Planned (schedule tz)</th><th>Company / to</th><th>Subject</th><th>Mailbox</th><th>Status</th><th>Actual</th></tr></thead>
                  <tbody>{sorted.map(({ sd, m, co }) => (
                    <tr key={sd.id}>
                      <td><input type="checkbox" name="sendId" value={sd.id} aria-label="Select send" /></td>
                      <td className="tabular-nums"><Link href={`/schedule${qs({ send: sd.id })}`}>{fmtDate(sd.plannedAt, zone)}</Link></td>
                      <td className="tabular-nums text-[12px]">{fmtDate(sd.plannedAt, sd.intentZone)}<div className="text-muted">{sd.intentZone} · {sd.mode === "recipient_local" ? "recipient time" : "my time"}</div></td>
                      <td>{co?.name ?? "—"}<div className="text-[11px] text-muted">{(m.toAddresses as string[]).join(", ")}</div></td>
                      <td className="max-w-xs truncate">{m.subject}</td>
                      <td className="text-[12px]">{mbLabel(sd.mailboxId)}</td>
                      <td><StateBadge state={sd.state} />{sd.resolutionRequired && <Badge tone="danger">needs decision</Badge>}{sd.holdReason && <div className="max-w-xs text-[11px] text-muted">{sd.holdReason}</div>}</td>
                      <td className="text-[11px]">{sd.submittedAt && <div>submitted {fmtDate(sd.submittedAt, zone)}</div>}{sd.recordedSentAt && <div>sent copy {fmtDate(sd.recordedSentAt, zone)}</div>}</td>
                    </tr>
                  ))}</tbody>
                </table>
                <div className="mt-2 flex gap-2"><Button formAction={resumeSendAction} type="submit">Resume selected (re-plan overdue)</Button><Button formAction={releaseHeldAction} type="submit">Release held after review (spread from now)</Button></div>
              </form>
            </Section>
          )}
        </div>
        <aside>{selected ? <Detail item={selected} zone={zone} mbLabel={mbLabel} keepApproval={st.keepApprovalOnReschedule} /> : <Section title="Details"><p className="text-[13px] text-muted">Select a message in the calendar, agenda or queue.</p></Section>}</aside>
      </div>
    </>
  );
}

type Item = { sd: typeof s.scheduledSends.$inferSelect; m: typeof s.messages.$inferSelect; co: typeof s.companies.$inferSelect | null };

function groupByDay(items: Item[], zone: string): [string, Item[]][] {
  const map = new Map<string, Item[]>();
  for (const it of items) {
    const k = DateTime.fromJSDate(it.sd.plannedAt, { zone }).toFormat("cccc d LLLL yyyy");
    map.set(k, [...(map.get(k) ?? []), it]);
  }
  return [...map.entries()];
}

function Calendar({ view, anchor, zone, items, qs }: { view: string; anchor: DateTime; zone: string; items: Item[]; qs: (e: Record<string, string>) => string }) {
  const start = view === "month" ? anchor.startOf("month").startOf("week") : anchor.startOf("week");
  const days = view === "month" ? 42 : 7;
  const prev = view === "month" ? anchor.minus({ months: 1 }) : anchor.minus({ weeks: 1 });
  const next = view === "month" ? anchor.plus({ months: 1 }) : anchor.plus({ weeks: 1 });
  const byDay = new Map<string, Item[]>();
  for (const it of items) {
    const k = DateTime.fromJSDate(it.sd.plannedAt, { zone }).toISODate()!;
    byDay.set(k, [...(byDay.get(k) ?? []), it]);
  }
  const today = DateTime.now().setZone(zone).toISODate();
  return (
    <Section title={view === "month" ? anchor.toFormat("LLLL yyyy") : `Week of ${start.toFormat("d LLL yyyy")}`} actions={<span className="flex gap-2 text-[13px]"><Link href={`/schedule${qs({ at: prev.toISODate()! })}`}>← Prev</Link><Link href={`/schedule${qs({ at: DateTime.now().toISODate()! })}`}>Today</Link><Link href={`/schedule${qs({ at: next.toISODate()! })}`}>Next →</Link></span>}>
      <div className="grid grid-cols-7 gap-px rounded-md bg-line" role="grid" aria-label="Calendar">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} role="columnheader" className="bg-surface-2 px-1 py-0.5 text-[11px] font-semibold text-muted">{d}</div>)}
        {Array.from({ length: days }, (_, i) => {
          const d = start.plus({ days: i });
          const key = d.toISODate()!;
          const list = byDay.get(key) ?? [];
          const dim = view === "month" && d.month !== anchor.month;
          return (
            <div key={key} role="gridcell" aria-label={`${d.toFormat("d LLLL")}: ${list.length} sends`} className={`bg-surface p-1 ${view === "week" ? "min-h-48" : "min-h-24"} ${dim ? "opacity-50" : ""}`}>
              <div className={`text-[11px] ${key === today ? "font-bold text-accent" : "text-muted"}`}>{d.day}</div>
              {list.slice(0, view === "week" ? 30 : 4).map(({ sd, co }) => (
                <Link key={sd.id} href={`/schedule${qs({ send: sd.id })}`} className="mb-px block truncate rounded border border-line px-1 text-[11px] text-fg no-underline hover:bg-surface-2" title={`${co?.name ?? ""} — ${sd.state}`}>
                  <span className="tabular-nums">{DateTime.fromJSDate(sd.plannedAt, { zone }).toFormat("HH:mm")}</span> {co?.name ?? "—"} <span className="text-muted">· {sd.state.replace("_", " ")}</span>
                </Link>
              ))}
              {list.length > (view === "week" ? 30 : 4) && <div className="text-[11px] text-muted">+{list.length - 4} more</div>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

async function Detail({ item, zone, mbLabel, keepApproval }: { item: Item; zone: string; mbLabel: (id: string) => string; keepApproval: boolean }) {
  const { sd, m, co } = item;
  const db = getDb();
  const [rev] = await db.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, sd.revisionId));
  const [ap] = sd.approvalId ? await db.select().from(s.approvals).where(eq(s.approvals.id, sd.approvalId)) : [];
  const events = await db.select().from(s.queueEvents).where(eq(s.queueEvents.scheduledSendId, sd.id)).orderBy(desc(s.queueEvents.at));
  const attempts = await db.select().from(s.dispatchAttempts).where(eq(s.dispatchAttempts.scheduledSendId, sd.id)).orderBy(desc(s.dispatchAttempts.startedAt));
  const editable = ["scheduled", "held", "paused", "failed"].includes(sd.state);
  const local = DateTime.fromJSDate(sd.plannedAt, { zone: sd.intentZone });
  void inArray;
  return (
    <Section title="Message details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[12px]">
        <dt className="text-muted">Status</dt><dd><StateBadge state={sd.state} /> <span className="text-muted">{STATE_LABEL[sd.state as SendState]}</span></dd>
        <dt className="text-muted">Company</dt><dd>{co ? <Link href={`/companies/${co.id}`}>{co.name}</Link> : "—"}</dd>
        <dt className="text-muted">To</dt><dd className="font-mono">{(rev.toAddresses as string[]).join(", ")}{(rev.ccAddresses as string[]).length ? ` (cc ${(rev.ccAddresses as string[]).join(", ")})` : ""}</dd>
        <dt className="text-muted">Mailbox</dt><dd>{mbLabel(sd.mailboxId)}</dd>
        <dt className="text-muted">Planned (you)</dt><dd className="tabular-nums">{fmtDate(sd.plannedAt, zone)} {zone}</dd>
        <dt className="text-muted">Planned (schedule)</dt><dd className="tabular-nums">{fmtDate(sd.plannedAt, sd.intentZone)} {sd.intentZone}</dd>
        <dt className="text-muted">Intent</dt><dd>{sd.intentLocal.replace("T", " ")} in {sd.intentZone} ({sd.mode === "recipient_local" ? "recipient’s time" : "my time"}){sd.dstResolution && sd.dstResolution !== "none" ? ` · DST: ${sd.dstResolution}` : ""}</dd>
        <dt className="text-muted">Approval</dt><dd>{ap ? (ap.revokedAt ? `revoked: ${ap.revokeReason}` : `revision ${rev.revisionNo} approved ${fmtDate(ap.approvedAt, zone)}`) : "none"}</dd>
        <dt className="text-muted">Attachments</dt><dd>{(rev.attachments as AttachmentRef[]).map((a) => <div key={a.documentVersionId}><a href={`/api/files/${a.documentVersionId}?inline=1`} target="_blank" rel="noopener">{a.filename}</a> <span className="text-muted">sha {a.sha256.slice(0, 10)}</span></div>)}{!(rev.attachments as AttachmentRef[]).length && "none"}</dd>
        <dt className="text-muted">Next attempt</dt><dd>{sd.nextAttemptAt ? fmtDate(sd.nextAttemptAt, zone) : "—"} · attempts {sd.attemptCount}</dd>
        {sd.holdReason && <><dt className="text-muted">Reason</dt><dd>{sd.holdReason}</dd></>}
        {sd.lastError && <><dt className="text-muted">Last error</dt><dd className="text-danger">{sd.lastError}</dd></>}
        {sd.submittedAt && <><dt className="text-muted">Submitted</dt><dd>{fmtDate(sd.submittedAt, zone)} (provider accepted; not proof of delivery)</dd></>}
        {sd.recordedSentAt && <><dt className="text-muted">Recorded sent</dt><dd>{fmtDate(sd.recordedSentAt, zone)} (sent copy found)</dd></>}
      </dl>
      <details className="mt-2" open><summary className="cursor-pointer text-[12px] font-medium">Full content preview</summary>
        <div className="mt-1 rounded border border-line p-2 text-[12px]"><div className="font-semibold">{rev.subject}</div><pre className="mt-1 whitespace-pre-wrap font-sans">{rev.bodyText}</pre></div>
      </details>
      {sd.state === "uncertain" && (
        <div className="mt-2"><Notice tone="danger" title="Outcome uncertain">{sd.lastError ?? "The send request may or may not have reached Microsoft. The app reconciles against Drafts/Sent Items before any retry."}</Notice>
          <form action={resolveUncertainAction} className="mt-1 flex flex-wrap gap-1"><input type="hidden" name="sendId" value={sd.id} />
            <Button name="decision" value="mark_sent" type="submit">I see it in Sent Items — mark sent</Button>
            <Button name="decision" value="retry_same_draft" type="submit" title="Re-sends the same provider draft; an already-sent draft is detected and not resent">Retry (same draft)</Button>
            <Button name="decision" value="cancel" variant="danger" type="submit">Cancel</Button>
          </form></div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {["scheduled", "held", "paused", "dispatching"].includes(sd.state) && <form action={cancelSendAction}><input type="hidden" name="sendId" value={sd.id} /><Button variant="danger" type="submit">Cancel</Button></form>}
        {["scheduled", "held"].includes(sd.state) && <form action={pauseSendAction}><input type="hidden" name="sendId" value={sd.id} /><Button type="submit">Pause</Button></form>}
        {["paused", "held"].includes(sd.state) && <form action={resumeSendAction}><input type="hidden" name="sendId" value={sd.id} /><Button type="submit">Resume</Button></form>}
        <Link href={`/drafts/${m.id}`} className="text-[13px]">Edit content (creates a new revision → needs approval)</Link>
      </div>
      {editable && (
        <form action={rescheduleAction} className="mt-2 flex flex-col gap-1 rounded border border-line p-2">
          <input type="hidden" name="sendId" value={sd.id} />
          <p className="text-[12px] font-medium">Reschedule</p>
          <div className="flex flex-wrap gap-1">
            <select name="mode" defaultValue={sd.mode} aria-label="Mode"><option value="recipient_local">recipient time</option><option value="my_local">my time</option></select>
            <input name="zone" defaultValue={sd.intentZone} aria-label="Timezone" className="w-36" />
            <input type="date" name="date" defaultValue={local.toISODate()!} aria-label="Date" />
            <input type="time" name="time" defaultValue={local.toFormat("HH:mm")} aria-label="Time" />
            <select name="dst" defaultValue="none" aria-label="DST resolution"><option value="none">DST: ask</option><option value="shift_forward">nonexistent → after change</option><option value="earlier_offset">ambiguous → first</option><option value="later_offset">ambiguous → second</option></select>
          </div>
          <p className="text-[11px] text-muted">Effect: {keepApproval ? "content and recipients are unchanged, so the approval is kept." : "your policy requires re-approval after rescheduling, so this schedule will be superseded and the message returned for approval."} Changing content instead creates a new revision that needs approval.</p>
          <Button type="submit">Save new time</Button>
        </form>
      )}
      <h3 className="mt-3 text-[12px] font-semibold">Activity</h3>
      <ol className="text-[11px]">{events.map((e) => <li key={e.id} className="border-b border-line py-0.5"><span className="tabular-nums text-muted">{fmtDate(e.at, zone)}</span> {e.fromState ?? "∅"} → <strong>{e.toState}</strong> · {e.actor}{e.reason ? ` — ${e.reason}` : ""}</li>)}</ol>
      {attempts.length > 0 && <><h3 className="mt-2 text-[12px] font-semibold">Dispatch attempts</h3><ul className="text-[11px]">{attempts.map((a) => <li key={a.id}>#{a.attemptNo} {a.workerId.slice(0, 24)} · {a.outcome ?? "in progress"}{a.httpStatus ? ` · HTTP ${a.httpStatus}` : ""}{a.providerRequestId ? ` · req ${a.providerRequestId}` : ""}{a.errorSummary ? ` — ${a.errorSummary}` : ""}</li>)}</ul></>}
    </Section>
  );
}
