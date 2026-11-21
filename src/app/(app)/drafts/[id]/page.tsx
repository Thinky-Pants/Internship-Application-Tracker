import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { approvalBlockers, currentApproval } from "@/domain/messages/compose";
import { recipientZoneSuggestion } from "@/domain/scheduling/service";
import { Badge, Button, Field, fmtDate, Notice, PageHeader, Section, StateBadge } from "@/components/ui";
import { Flash } from "@/components/flash";
import { Composer } from "@/components/composer";
import { saveRevisionAction, approveAction, sendNowAction, scheduleAction } from "@/app/actions/drafts";
import type { AttachmentRef } from "@/domain/messages/compose";

export const metadata = { title: "Draft" };

export default async function DraftPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const [m] = await db.select().from(s.messages).where(and(eq(s.messages.id, id), eq(s.messages.ownerId, owner.id)));
  if (!m) notFound();
  if (m.direction === "inbound" && m.conversationId) return <Notice>This is a received message. <Link href={`/inbox/${m.conversationId}`}>Open the conversation</Link>.</Notice>;
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const zone = st.displayTimezone;
  const revisions = await db.select().from(s.messageRevisions).where(eq(s.messageRevisions.messageId, id)).orderBy(desc(s.messageRevisions.revisionNo));
  const rev = revisions.find((r) => r.id === m.currentRevisionId)!;
  const [co] = m.companyId ? await db.select().from(s.companies).where(eq(s.companies.id, m.companyId)) : [];
  const [ct] = m.contactId ? await db.select().from(s.contacts).where(eq(s.contacts.id, m.contactId)) : [];
  const mailboxes = await db.select().from(s.mailboxes).where(eq(s.mailboxes.ownerId, owner.id));
  const docs = await db.select({ v: s.documentVersions, d: s.documents }).from(s.documentVersions).innerJoin(s.documents, eq(s.documents.id, s.documentVersions.documentId)).where(eq(s.documents.ownerId, owner.id));
  const ca = await currentApproval(db, id);
  const blockers = await approvalBlockers(db, owner.id, rev);
  const approvals = await db.select().from(s.approvals).where(eq(s.approvals.messageId, id)).orderBy(desc(s.approvals.approvedAt));
  const sends = await db.select().from(s.scheduledSends).where(eq(s.scheduledSends.messageId, id)).orderBy(desc(s.scheduledSends.createdAt));
  const activeSend = sends.find((x) => ["scheduled", "held", "paused", "dispatching", "submitted", "uncertain"].includes(x.state));
  const locked = sends.some((x) => ["dispatching", "submitted", "uncertain", "recorded_sent"].includes(x.state));
  const tz = await recipientZoneSuggestion(db, m.companyId);
  const others = m.companyId ? await db.select().from(s.messages).where(and(eq(s.messages.companyId, m.companyId), eq(s.messages.direction, "outbound"), inArray(s.messages.status, ["scheduled", "submitted", "recorded_sent", "approved"]))) : [];
  const otherPeople = others.filter((o) => o.id !== id && o.contactId !== m.contactId);
  const nextMon = DateTime.now().setZone(tz.zone ?? zone).plus({ days: 1 }).startOf("week").plus({ weeks: 1 });
  return (
    <>
      <PageHeader
        title={rev.subject || "(no subject)"}
        subtitle={<>{co ? <Link href={`/companies/${co.id}`}>{co.name}</Link> : "No company"}{ct ? ` · ${ct.fullName}${ct.title ? ` (${ct.title})` : ""}` : ""} · revision {rev.revisionNo} · <StateBadge state={m.status} /> {m.kind !== "initial" && <Badge>{m.kind}</Badge>}</>}
        actions={<Link href="/drafts">All drafts</Link>}
      />
      <Flash sp={sp} />
      {otherPeople.length > 0 && <div className="mb-3"><Notice tone="warn" title="Simultaneous outreach">Another person at {co?.name} already has an approved, scheduled or sent message. Consider waiting for a reply first.</Notice></div>}
      {locked && <div className="mb-3"><Notice tone="info">This message has been dispatched or submitted, so its content is locked. Create a follow-up instead.</Notice></div>}
      <Section title="Compose (each save creates an immutable revision)">
        <Composer
          messageId={id}
          subject={rev.subject}
          bodyHtml={rev.bodyHtml}
          to={(rev.toAddresses as string[]).join(", ")}
          cc={(rev.ccAddresses as string[]).join(", ")}
          mailboxId={rev.mailboxId ?? ""}
          mailboxes={mailboxes.map((mb) => ({ id: mb.id, label: `${mb.emailAddress ?? "(unnamed)"} — ${mb.provider}${mb.status !== "connected" ? ` [${mb.status}]` : ""}` }))}
          attachments={(rev.attachments as AttachmentRef[]).map((a) => a.documentVersionId)}
          cvs={docs.map(({ v, d }) => ({ versionId: v.id, label: `${d.title} — v${v.versionNo} ${v.filename} (${Math.round(v.sizeBytes / 1024)} KB, sha ${v.sha256.slice(0, 8)})` }))}
          disabled={locked}
          action={saveRevisionAction}
        />
      </Section>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Section title="Approval">
          {ca ? (
            <Notice tone="ok" title={`Approved revision ${ca.revision.revisionNo}`}>Approved {fmtDate(ca.approval.approvedAt, zone)} via {ca.approval.approvedVia}. Content hash {ca.revision.contentHash.slice(0, 12)}… Future scheduled dispatch of this exact content needs no further click.</Notice>
          ) : blockers.length ? (
            <Notice tone="warn" title="Cannot approve yet"><ul className="list-disc pl-4">{blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul></Notice>
          ) : (
            <form action={approveAction}><input type="hidden" name="messageId" value={id} /><p className="mb-2 text-[12px] text-muted">Approval covers this revision’s subject, body, recipients, mailbox and attachment versions — nothing else.</p><Button variant="primary" type="submit" disabled={locked}>Approve revision {rev.revisionNo}</Button></form>
          )}
          {!locked && !activeSend && !blockers.length && (
            <form action={sendNowAction} className="mt-2"><input type="hidden" name="messageId" value={id} /><Button type="submit" title="Approves the displayed revision and queues it immediately">Approve & send now</Button></form>
          )}
          {approvals.length > 0 && <ul className="mt-2 text-[11px] text-muted">{approvals.map((a) => <li key={a.id}>rev {revisions.find((r) => r.id === a.revisionId)?.revisionNo}: {fmtDate(a.approvedAt, zone)}{a.revokedAt ? ` — revoked: ${a.revokeReason}` : ""}</li>)}</ul>}
        </Section>
        <Section title="Schedule">
          {activeSend ? (
            <p className="text-[13px]">Already {activeSend.state}: planned {fmtDate(activeSend.plannedAt, zone)} (you) · {fmtDate(activeSend.plannedAt, activeSend.intentZone)} ({activeSend.intentZone}). <Link href={`/schedule?send=${activeSend.id}`}>Open in queue</Link></p>
          ) : !ca ? <p className="text-[13px] text-muted">Approve first.</p> : (
            <form action={scheduleAction} className="flex flex-col gap-2">
              <input type="hidden" name="messageId" value={id} />
              <fieldset className="flex flex-col gap-1 text-[13px]">
                <legend className="text-[12px] text-muted">Interpret the time in…</legend>
                <label className="flex items-center gap-2 text-fg"><input type="radio" name="mode" value="recipient_local" defaultChecked={!!tz.zone} /> Recipient’s business timezone</label>
                <label className="flex items-center gap-2 text-fg"><input type="radio" name="mode" value="my_local" defaultChecked={!tz.zone} /> My timezone ({zone})</label>
              </fieldset>
              <Field label="Recipient timezone (used in recipient mode)" htmlFor="s-zone" hint={tz.explanation}>
                <input id="s-zone" name="zone" list="s-zones" defaultValue={tz.zone ?? zone} required />
              </Field>
              <datalist id="s-zones">{[...tz.candidates, zone].map((z) => <option key={z} value={z} />)}</datalist>
              <div className="flex gap-2">
                <Field label="Local date" htmlFor="s-date"><input id="s-date" name="date" type="date" defaultValue={nextMon.toFormat("yyyy-MM-dd")} required /></Field>
                <Field label="Local time" htmlFor="s-time"><input id="s-time" name="time" type="time" defaultValue="07:00" required /></Field>
              </div>
              <Field label="If the time falls in a DST change" htmlFor="s-dst"><select id="s-dst" name="dst"><option value="none">Ask me (reject ambiguous/nonexistent times)</option><option value="shift_forward">Nonexistent: first valid time after the change</option><option value="earlier_offset">Ambiguous: first occurrence</option><option value="later_offset">Ambiguous: second occurrence</option></select></Field>
              <p className="text-[11px] text-muted">If the chosen time is outside your sending window, it moves to the start of the next allowed window in that timezone. This is a planned send time, not a guaranteed arrival time.</p>
              <Button variant="primary" type="submit">Schedule</Button>
            </form>
          )}
        </Section>
        <Section title="Revision history">
          <ol className="text-[12px]">{revisions.map((r) => <li key={r.id} className="mb-1">rev {r.revisionNo} · {fmtDate(r.createdAt, zone)} · {r.createdBy.replace("_", " ")} · {(r.attachments as AttachmentRef[]).map((a) => a.filename).join(", ") || "no attachments"} · hash {r.contentHash.slice(0, 8)}</li>)}</ol>
          {sends.length > 0 && <><h3 className="mt-2 text-[12px] font-semibold">Sends</h3><ul className="text-[12px]">{sends.map((x) => <li key={x.id}><Link href={`/schedule?send=${x.id}`}>{x.state}</Link> · planned {fmtDate(x.plannedAt, zone)} · rev {revisions.find((r) => r.id === x.revisionId)?.revisionNo}</li>)}</ul></>}
        </Section>
      </div>
    </>
  );
}
