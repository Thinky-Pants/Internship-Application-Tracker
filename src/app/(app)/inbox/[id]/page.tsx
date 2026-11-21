import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { CATEGORY_LABEL } from "@/domain/mail/classify";
import { Badge, Button, Field, fmtDate, Notice, PageHeader, Section, StateBadge } from "@/components/ui";
import { Flash } from "@/components/flash";
import { setCategoryAction, reassignAction, markReadAction, replyDraftAction, aiSummaryAction, aiClassifyAction } from "@/app/actions/inbox";
import { upsertOpportunityAction, addReminderAction } from "@/app/actions/companies";

export const metadata = { title: "Conversation" };

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const [c] = await db.select().from(s.conversations).where(and(eq(s.conversations.id, id), eq(s.conversations.ownerId, owner.id)));
  if (!c) notFound();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const zone = st.displayTimezone;
  const msgs = (await db.select().from(s.messages).where(eq(s.messages.conversationId, id))).sort((a, b) => (a.receivedAt ?? a.recordedSentAt ?? a.createdAt).getTime() - (b.receivedAt ?? b.recordedSentAt ?? b.createdAt).getTime());
  const [co] = c.companyId ? await db.select().from(s.companies).where(eq(s.companies.id, c.companyId)) : [];
  const contacts = c.companyId ? await db.select().from(s.contacts).where(eq(s.contacts.companyId, c.companyId)) : [];
  const opps = c.companyId ? await db.select().from(s.opportunities).where(eq(s.opportunities.companyId, c.companyId)) : [];
  const companies = c.matchStatus === "ambiguous" || !c.companyId ? await db.select({ id: s.companies.id, name: s.companies.name, domain: s.companies.domain }).from(s.companies).where(eq(s.companies.ownerId, owner.id)) : [];
  const fromDomain = msgs.find((m) => m.direction === "inbound")?.fromAddress?.split("@")[1];
  const likely = companies.filter((x) => fromDomain && x.domain && (fromDomain === x.domain || fromDomain.endsWith("." + x.domain)));
  const lastIn = [...msgs].reverse().find((m) => m.direction === "inbound");
  return (
    <>
      <PageHeader title={c.subject ?? "(no subject)"} subtitle={<>{co ? <Link href={`/companies/${co.id}`}>{co.name}</Link> : <span className="text-warn">Not assigned to a company</span>} · match: {c.matchStatus}{c.matchReason ? ` (${c.matchReason})` : ""}</>}
        actions={<><form action={markReadAction}><input type="hidden" name="conversationId" value={id} /><Button type="submit">Mark read</Button></form><form action={aiSummaryAction}><input type="hidden" name="conversationId" value={id} /><Button type="submit">AI summary & next action</Button></form><Link href="/inbox">Inbox</Link></>} />
      <Flash sp={sp} />
      {c.matchStatus === "ambiguous" && (
        <div className="mb-3"><Notice tone="warn" title="Ambiguous match — not merged">This message matched only by sender domain (or several companies). It is kept separate until you assign it.
          <form action={reassignAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="conversationId" value={id} />
            <Field label="Company" htmlFor="ra-co"><select id="ra-co" name="companyId" defaultValue={likely[0]?.id ?? ""}><option value="">— none —</option>{[...likely, ...companies.filter((x) => !likely.includes(x)).slice(0, 500)].map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Contact (optional)" htmlFor="ra-ct"><select id="ra-ct" name="contactId"><option value="">—</option>{contacts.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</select></Field>
            <Button type="submit">Assign</Button>
          </form></Notice></div>
      )}
      {c.summary && <div className="mb-3"><Notice title="AI summary (suggestion)">{c.summary}</Notice></div>}
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-2">
          {msgs.map((m) => (
            <article key={m.id} className={`rounded-lg border bg-surface p-3 ${m.direction === "inbound" ? "border-line" : "border-dashed border-line"}`} aria-label={`${m.direction} message`}>
              <header className="mb-1 flex flex-wrap items-center gap-2 text-[12px]">
                <strong>{m.direction === "inbound" ? m.fromAddress : `You → ${(m.toAddresses as string[]).join(", ")}`}</strong>
                <span className="text-muted">{fmtDate(m.receivedAt ?? m.recordedSentAt ?? m.submittedAt ?? m.createdAt, zone)}</span>
                {m.direction === "outbound" && <StateBadge state={m.status} />}
                {m.isBounce && <Badge tone="danger">bounce</Badge>}
                {m.isAutomated && !m.isBounce && <Badge>automated</Badge>}
                {m.category && <Badge tone="info" title={`${m.categorySource}${m.categoryConfidence ? ` ${Math.round(m.categoryConfidence * 100)}%` : ""}`}>{CATEGORY_LABEL[m.category as keyof typeof CATEGORY_LABEL] ?? m.category} ({m.categorySource})</Badge>}
                {m.webLink && <a href={m.webLink} target="_blank" rel="noopener noreferrer">Open in Outlook</a>}
                {m.hasAttachments && <Badge>attachments in Outlook</Badge>}
              </header>
              <div className="mb-1 text-[13px] font-semibold">{m.subject}</div>
              <pre className="whitespace-pre-wrap font-sans text-[13px]">{(m.bodyText ?? "").slice(0, 8000)}</pre>
              {m.direction === "inbound" && (
                <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-2">
                  <form action={setCategoryAction} className="flex items-end gap-1">
                    <input type="hidden" name="conversationId" value={id} /><input type="hidden" name="messageId" value={m.id} />
                    <label htmlFor={`cat-${m.id}`} className="sr-only">Category</label>
                    <select id={`cat-${m.id}`} name="category" defaultValue={m.category ?? "uncertain"}>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                    <Button type="submit">Set category</Button>
                  </form>
                  <form action={aiClassifyAction}><input type="hidden" name="conversationId" value={id} /><input type="hidden" name="messageId" value={m.id} /><Button type="submit">AI suggest</Button></form>
                  <form action={replyDraftAction}><input type="hidden" name="conversationId" value={id} /><input type="hidden" name="messageId" value={m.id} /><Button variant="primary" type="submit">Reply in thread</Button></form>
                </div>
              )}
            </article>
          ))}
        </div>
        <aside className="flex flex-col gap-3">
          <Section title="Next step">
            <p className="mb-2 text-[12px] text-muted">A reply is not automatically a positive opportunity. Follow-ups for this {st.companyCoordinationPolicy === "pause_company" ? "company" : "contact"} were paused when it arrived (policy: {st.companyCoordinationPolicy.replace(/_/g, " ")}).</p>
            {co && opps.map((o) => (
              <form key={o.id} action={upsertOpportunityAction} className="mb-2 flex items-end gap-1">
                <input type="hidden" name="companyId" value={co.id} /><input type="hidden" name="id" value={o.id} /><input type="hidden" name="roleTitle" value={o.roleTitle} />
                <Field label={o.roleTitle} htmlFor={`st-${o.id}`}><select id={`st-${o.id}`} name="stage" defaultValue={o.stage}>{["prospect", "applied_contacted", "screening", "interview", "offer", "rejected", "withdrawn", "closed"].map((x) => <option key={x}>{x}</option>)}</select></Field>
                <Button type="submit">Update stage</Button>
              </form>
            ))}
            {co && !opps.length && <form action={upsertOpportunityAction}><input type="hidden" name="companyId" value={co.id} /><input type="hidden" name="stage" value={lastIn?.category === "positive_interest" ? "screening" : "applied_contacted"} /><Button type="submit">Create opportunity record</Button></form>}
            {co && (
              <form action={addReminderAction} className="mt-2 flex flex-col gap-1">
                <input type="hidden" name="companyId" value={co.id} />
                <Field label="Reminder" htmlFor="cr-t"><input id="cr-t" name="title" defaultValue={lastIn?.category === "out_of_office" ? `Follow up with ${co.name} after their return` : `Reply to ${co.name}`} /></Field>
                <Field label="Due" htmlFor="cr-d"><input id="cr-d" name="dueAt" type="date" /></Field>
                <Button type="submit">Add reminder</Button>
              </form>
            )}
          </Section>
        </aside>
      </div>
    </>
  );
}
