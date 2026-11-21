import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { listCompanies } from "@/server/queries";
import { scanPlaceholders } from "@/domain/templates";
import { Badge, Button, Empty, Field, fmtDate, PageHeader, Section, StateBadge } from "@/components/ui";
import { Flash } from "@/components/flash";
import { batchApproveAction, batchDraftsAction } from "@/app/actions/drafts";
import type { AttachmentRef } from "@/domain/messages/compose";

export const metadata = { title: "Drafts & Review" };

export default async function DraftsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const tab = sp.tab ?? "review";
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  return (
    <>
      <PageHeader title="Drafts & Review" subtitle="Every edit is a new revision; approval binds one exact revision, recipients, mailbox and CV version." />
      <Flash sp={sp} />
      <nav className="mb-3 flex gap-1" aria-label="Draft sections">
        {[["review", "Review queue"], ["batch", "Batch create"]].map(([k, l]) => <Link key={k} href={`/drafts?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`rounded-md px-2.5 py-1 text-[13px] no-underline ${tab === k ? "bg-surface-2 font-semibold text-fg" : "text-muted"}`}>{l}</Link>)}
      </nav>
      {tab === "review" ? <Review ownerId={owner.id} zone={st.displayTimezone} /> : <Batch ownerId={owner.id} />}
    </>
  );
}

async function Review({ ownerId, zone }: { ownerId: string; zone: string }) {
  const db = getDb();
  const msgs = await db.select({ m: s.messages, co: s.companies }).from(s.messages).leftJoin(s.companies, eq(s.companies.id, s.messages.companyId))
    .where(and(eq(s.messages.ownerId, ownerId), eq(s.messages.direction, "outbound"), inArray(s.messages.status, ["draft", "awaiting_approval", "approved"]))).orderBy(desc(s.messages.updatedAt)).limit(300);
  const revIds = msgs.map((x) => x.m.currentRevisionId!).filter(Boolean);
  const revs = revIds.length ? await db.select().from(s.messageRevisions).where(inArray(s.messageRevisions.id, revIds)) : [];
  if (!msgs.length) return <Empty title="No drafts awaiting review">Prepare one from a company page, or batch-create from a template.</Empty>;
  return (
    <form>
      <Section title={`${msgs.length} messages`} actions={<div className="flex gap-2">
        <Button formAction={batchApproveAction} type="submit">Approve selected</Button>
        <Button formAction="/schedule/batch" formMethod="get" variant="primary" type="submit">Schedule selected…</Button>
      </div>}>
        <p className="mb-2 text-[12px] text-muted">Tick messages to approve or schedule together. Unticked messages are excluded. Open any message to edit it individually first — edits create a new revision and require approval again.</p>
        <table className="data">
          <thead><tr><th><span className="sr-only">Select</span></th><th>Company / recipient</th><th>Subject & preview</th><th>CV</th><th>Status</th><th>Issues</th></tr></thead>
          <tbody>{msgs.map(({ m, co }) => {
            const rev = revs.find((r) => r.id === m.currentRevisionId);
            const ph = rev ? scanPlaceholders(rev.subject + rev.bodyHtml) : [];
            const noTo = !rev || !(rev.toAddresses as string[]).length;
            return (
              <tr key={m.id}>
                <td><input type="checkbox" name="messageId" value={m.id} aria-label={`Select ${rev?.subject ?? "message"}`} /></td>
                <td>{co ? <Link href={`/companies/${co.id}`}>{co.name}</Link> : "—"}<div className="text-[11px] text-muted">{((rev?.toAddresses as string[]) ?? []).join(", ") || "no recipient"}</div></td>
                <td><Link href={`/drafts/${m.id}`}>{rev?.subject || "(no subject)"}</Link><div className="max-w-md truncate text-[11px] text-muted">{rev?.bodyText.slice(0, 160)}</div></td>
                <td className="text-[11px]">{((rev?.attachments as AttachmentRef[]) ?? []).map((a) => a.filename).join(", ") || "—"}</td>
                <td><StateBadge state={m.status} /><div className="text-[11px] text-muted">rev {rev?.revisionNo} · {fmtDate(m.updatedAt, zone)}</div>{m.kind === "followup" && <Badge>follow-up</Badge>}</td>
                <td className="text-[11px] text-danger">{ph.length ? `placeholders: ${ph.map((p) => p.name).join(", ")}` : ""}{noTo ? " no recipient" : ""}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </Section>
    </form>
  );
}

async function Batch({ ownerId }: { ownerId: string }) {
  const db = getDb();
  const [rows, templates, mailboxes, docs, campaigns] = await Promise.all([
    listCompanies(ownerId, { email: "usable", progress: "not_contacted" }),
    db.select().from(s.templates).where(eq(s.templates.ownerId, ownerId)),
    db.select().from(s.mailboxes).where(eq(s.mailboxes.ownerId, ownerId)),
    db.select({ v: s.documentVersions, d: s.documents }).from(s.documents).innerJoin(s.documentVersions, eq(s.documentVersions.id, s.documents.currentVersionId)).where(eq(s.documents.ownerId, ownerId)),
    db.select().from(s.campaigns).where(eq(s.campaigns.ownerId, ownerId)),
  ]);
  return (
    <form action={batchDraftsAction}>
      <Section title="Create drafts for companies with a usable address that have not been contacted" actions={<Button variant="primary" type="submit">Create drafts</Button>}>
        <div className="mb-3 flex flex-wrap gap-3">
          <Field label="Template" htmlFor="b-t"><select id="b-t" name="templateId">{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Mailbox" htmlFor="b-m"><select id="b-m" name="mailboxId">{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.emailAddress ?? m.provider} ({m.status})</option>)}</select></Field>
          <Field label="CV version" htmlFor="b-cv"><select id="b-cv" name="cvVersionId"><option value="">None</option>{docs.map(({ v, d }) => <option key={v.id} value={v.id}>{d.title} v{v.versionNo}</option>)}</select></Field>
          <Field label="Campaign" htmlFor="b-c"><select id="b-c" name="campaignId"><option value="">None</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <p className="mb-2 text-[12px] text-muted">Drafts use each company’s primary contact (or first contact) and are NOT approved. Up to 100 at once. Missing placeholders are shown per draft and block approval.</p>
        {rows.length === 0 ? <Empty title="No eligible companies">Find contacts and addresses first.</Empty> : (
          <table className="data"><thead><tr><th><span className="sr-only">Select</span></th><th>Company</th><th>Priority</th><th>Country</th><th>Contacts</th></tr></thead>
            <tbody>{rows.slice(0, 300).map(({ company: c, summary }) => (
              <tr key={c.id}><td><input type="checkbox" name="companyId" value={c.id} aria-label={`Select ${c.name}`} /></td><td><Link href={`/companies/${c.id}`}>{c.name}</Link></td><td>{c.priority}</td><td>{c.country}</td><td>{summary.contactCount}</td></tr>
            ))}</tbody></table>
        )}
      </Section>
    </form>
  );
}
