import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { Button, Field, PageHeader, Section } from "@/components/ui";
import { Flash } from "@/components/flash";
import { createDraftAction, aiDraftAction } from "@/app/actions/drafts";

export const metadata = { title: "New draft" };

export default async function NewDraft({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const db = getDb();
  const [co] = sp.companyId ? await db.select().from(s.companies).where(and(eq(s.companies.id, sp.companyId), eq(s.companies.ownerId, owner.id))) : [];
  if (!co) notFound();
  const sequences = await db.select().from(s.sequences).where(eq(s.sequences.ownerId, owner.id));
  const [contacts, templates, mailboxes, docs, campaigns] = await Promise.all([
    db.select().from(s.contacts).where(eq(s.contacts.companyId, co.id)),
    db.select().from(s.templates).where(eq(s.templates.ownerId, owner.id)),
    db.select().from(s.mailboxes).where(eq(s.mailboxes.ownerId, owner.id)),
    db.select({ v: s.documentVersions, d: s.documents }).from(s.documents).innerJoin(s.documentVersions, eq(s.documentVersions.id, s.documents.currentVersionId)).where(and(eq(s.documents.ownerId, owner.id), eq(s.documents.archived, false))),
    db.select().from(s.campaigns).where(eq(s.campaigns.ownerId, owner.id)),
  ]);
  const suggestedCv = docs.find(({ d }) => d.id === co.selectedCvDocumentId) ?? docs.find(({ d }) => (d.industryTags as string[]).some((t) => (co.industryPrimary ?? "").toLowerCase().includes(t.toLowerCase()))) ?? docs[0];
  const common = (
    <>
      <input type="hidden" name="companyId" value={co.id} />
      <Field label="Contact" htmlFor="n-ct"><select id="n-ct" name="contactId" defaultValue={sp.contactId ?? co.preferredContactId ?? ""}><option value="">(none — general inbox)</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.fullName}{c.title ? ` — ${c.title}` : ""}</option>)}</select></Field>
      <Field label="Mailbox" htmlFor="n-mb"><select id="n-mb" name="mailboxId">{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.emailAddress ?? m.provider} ({m.status})</option>)}</select></Field>
      <Field label="CV (current version is pinned into the draft)" htmlFor="n-cv" hint={suggestedCv ? `Suggested: ${suggestedCv.d.title} (industry tags / selection).` : "Upload a CV in CVs & Templates."}>
        <select id="n-cv" name="cvVersionId" defaultValue={suggestedCv?.v.id ?? ""}><option value="">No attachment</option>{docs.map(({ v, d }) => <option key={v.id} value={v.id}>{d.title} — v{v.versionNo} ({v.filename})</option>)}</select>
      </Field>
    </>
  );
  return (
    <>
      <PageHeader title={`New draft — ${co.name}`} />
      <Flash sp={sp} />
      <div className="grid gap-3 md:grid-cols-2">
        <Section title="From a template">
          <form action={createDraftAction} className="flex flex-col gap-2">
            {common}
            <Field label="Template" htmlFor="n-tpl"><select id="n-tpl" name="templateId">{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}<option value="">Blank</option></select></Field>
            <Field label="Personalisation sentence (evidence-backed)" htmlFor="n-p" hint="Used for {{personalization}}. Base it on a fact you verified."><textarea id="n-p" name="personalization" rows={2} defaultValue={co.engineeringActivity ? `I was interested to read that ${co.name} ${co.engineeringActivity.charAt(0).toLowerCase()}${co.engineeringActivity.slice(1)}` : ""} /></Field>
            <Field label="Campaign" htmlFor="n-cmp"><select id="n-cmp" name="campaignId"><option value="">None</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Follow-up sequence" htmlFor="n-seq" hint="Follow-ups are drafted for review after this message is recorded sent."><select id="n-seq" name="sequenceId"><option value="">None</option>{sequences.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select></Field>
            <Button variant="primary" type="submit">Create draft</Button>
          </form>
        </Section>
        <Section title="AI suggestion (optional)">
          <form action={aiDraftAction} className="flex flex-col gap-2">
            {common}
            <p className="text-[12px] text-muted">Uses only your verified profile and this company’s approved evidence. The model cannot browse unless the provider supports it, never approves or sends, and unsupported statements are flagged. Requires an AI key in Settings (or demo mode).</p>
            <Button type="submit">Draft with AI</Button>
          </form>
        </Section>
      </div>
    </>
  );
}
