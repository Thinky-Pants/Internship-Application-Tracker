import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { PLACEHOLDERS } from "@/domain/templates";
import type { CandidateProfile } from "@/domain/outreach/personalize";
import type { FollowupStep } from "@/domain/outreach/sequences";
import { Badge, Button, Field, fmtDate, PageHeader, Section } from "@/components/ui";
import { Flash } from "@/components/flash";
import { uploadCvAction, archiveCvAction, saveTemplateAction, saveProfileAction, saveSequenceAction } from "@/app/actions/library";

export const metadata = { title: "CVs & Templates" };

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const tab = sp.tab ?? "cvs";
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  return (
    <>
      <PageHeader title="CVs & Templates" subtitle="Versioned PDF CVs, reusable templates, your verified profile, and follow-up sequences." />
      <Flash sp={sp} />
      <nav className="mb-3 flex gap-1" aria-label="Library sections">{[["cvs", "CV library"], ["templates", "Templates"], ["profile", "Verified profile"], ["sequences", "Sequences"]].map(([k, l]) => <Link key={k} href={`/library?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`rounded-md px-2.5 py-1 text-[13px] no-underline ${tab === k ? "bg-surface-2 font-semibold text-fg" : "text-muted"}`}>{l}</Link>)}</nav>
      {tab === "cvs" && <Cvs ownerId={owner.id} zone={st.displayTimezone} />}
      {tab === "templates" && <Templates ownerId={owner.id} edit={sp.edit} />}
      {tab === "profile" && <Profile ownerId={owner.id} />}
      {tab === "sequences" && <Sequences ownerId={owner.id} />}
    </>
  );
}

async function Cvs({ ownerId, zone }: { ownerId: string; zone: string }) {
  const db = getDb();
  const docs = await db.select().from(s.documents).where(eq(s.documents.ownerId, ownerId));
  const versions = await db.select().from(s.documentVersions).orderBy(desc(s.documentVersions.versionNo));
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section title="Upload a CV (PDF)">
        <form action={uploadCvAction} className="flex flex-col gap-2" encType="multipart/form-data">
          <Field label="PDF file (≤10 MB; email attachments ≤3 MB)" htmlFor="cv-f"><input id="cv-f" name="file" type="file" accept="application/pdf" required /></Field>
          <Field label="Add as new version of" htmlFor="cv-d"><select id="cv-d" name="documentId"><option value="">A new CV</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
          <Field label="Title (new CV)" htmlFor="cv-t"><input id="cv-t" name="title" placeholder="Robotics & automation CV" /></Field>
          <Field label="Industry tags (comma-separated)" htmlFor="cv-g"><input id="cv-g" name="tags" placeholder="Robotics, Automotive" /></Field>
          <Field label="Description" htmlFor="cv-ds"><input id="cv-ds" name="description" /></Field>
          <Field label="Version note" htmlFor="cv-n"><input id="cv-n" name="note" /></Field>
          <Button variant="primary" type="submit">Upload</Button>
          <p className="text-[11px] text-muted">CVs are created in your separate CV app; upload its PDFs here. Each upload stores exact bytes and a SHA-256 hash. Integration boundary: documents.external_source / external_ref (docs/ARCHITECTURE.md).</p>
        </form>
      </Section>
      <Section title="Library" className="lg:col-span-2">
        {docs.length === 0 ? <p className="text-[13px] text-muted">No CVs yet.</p> : docs.map((d) => (
          <div key={d.id} className="mb-3 border-b border-line pb-2">
            <div className="flex items-center gap-2"><strong>{d.title}</strong>{(d.industryTags as string[]).map((t) => <Badge key={t}>{t}</Badge>)}{d.archived && <Badge tone="warn">archived</Badge>}
              <form action={archiveCvAction} className="ml-auto"><input type="hidden" name="documentId" value={d.id} /><input type="hidden" name="on" value={d.archived ? "0" : "1"} /><Button type="submit">{d.archived ? "Unarchive" : "Archive"}</Button></form></div>
            {d.description && <p className="text-[12px] text-muted">{d.description}</p>}
            <table className="data mt-1"><thead><tr><th>Version</th><th>File</th><th>Uploaded</th><th>SHA-256</th><th>Preview</th></tr></thead>
              <tbody>{versions.filter((v) => v.documentId === d.id).map((v) => (
                <tr key={v.id}><td>v{v.versionNo}{v.id === d.currentVersionId && <> <Badge tone="info">current</Badge></>}</td><td>{v.filename} <span className="text-muted">({Math.round(v.sizeBytes / 1024)} KB)</span>{v.sizeBytes > 3 * 1024 * 1024 && <Badge tone="warn">over 3 MB</Badge>}</td><td>{fmtDate(v.uploadedAt, zone)}</td><td className="font-mono text-[11px]">{v.sha256.slice(0, 16)}…</td><td><a href={`/api/files/${v.id}?inline=1`} target="_blank" rel="noopener">View</a> · <a href={`/api/files/${v.id}`}>Download</a></td></tr>
              ))}</tbody></table>
          </div>
        ))}
      </Section>
    </div>
  );
}

async function Templates({ ownerId, edit }: { ownerId: string; edit?: string }) {
  const tpls = await getDb().select().from(s.templates).where(eq(s.templates.ownerId, ownerId));
  const cur = tpls.find((t) => t.id === edit);
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section title="Templates">
        <ul className="text-[13px]">{tpls.map((t) => <li key={t.id}><Link href={`/library?tab=templates&edit=${t.id}`}>{t.name}</Link> <Badge>{t.kind}</Badge></li>)}</ul>
        <p className="mt-2 text-[12px]"><Link href="/library?tab=templates">+ New template</Link></p>
        <h3 className="mt-3 text-[12px] font-semibold">Placeholders</h3>
        <ul className="text-[11px]">{Object.entries(PLACEHOLDERS).map(([k, v]) => <li key={k}><code>{`{{${k}}}`}</code> — {v}</li>)}</ul>
        <p className="mt-1 text-[11px] text-muted">Add <code>?</code> to make one optional, e.g. <code>{"{{project?}}"}</code>. Missing required values block approval. Project, skill and availability come only from verified profile items.</p>
      </Section>
      <Section title={cur ? `Edit: ${cur.name}` : "New template"} className="lg:col-span-2">
        <form action={saveTemplateAction} className="flex flex-col gap-2">
          {cur && <input type="hidden" name="id" value={cur.id} />}
          <div className="flex gap-2"><Field label="Name" htmlFor="t-n"><input id="t-n" name="name" defaultValue={cur?.name} required /></Field>
            <Field label="Kind" htmlFor="t-k"><select id="t-k" name="kind" defaultValue={cur?.kind ?? "initial"}><option value="initial">Initial</option><option value="followup">Follow-up</option><option value="reply">Reply</option></select></Field></div>
          <Field label="Subject" htmlFor="t-s"><input id="t-s" name="subject" defaultValue={cur?.subject ?? "Summer 2027 mechanical engineering internship — {{company.name}}"} /></Field>
          <Field label="Body (HTML)" htmlFor="t-b"><textarea id="t-b" name="bodyHtml" rows={12} className="font-mono text-[12px]" defaultValue={cur?.bodyHtml ?? "<p>Dear {{contact.first_name}},</p>\n<p>{{personalization}}</p>\n<p>I am a mechanical engineering student looking for {{role}}. {{project?}}</p>\n<p>I am available {{availability}}. My CV is attached.</p>\n{{signature}}"} /></Field>
          <Field label="Always-required placeholders (comma-separated)" htmlFor="t-r"><input id="t-r" name="required" defaultValue={((cur?.requiredPlaceholders as string[]) ?? []).join(", ")} /></Field>
          <Button variant="primary" type="submit">Save template</Button>
        </form>
      </Section>
    </div>
  );
}

async function Profile({ ownerId }: { ownerId: string }) {
  const [p] = await getDb().select().from(s.candidateProfile).where(eq(s.candidateProfile.ownerId, ownerId));
  const d = (p?.data ?? {}) as CandidateProfile;
  const v = (items?: { verified: boolean }[]) => !!items?.length && items.every((i) => i.verified);
  const area = (name: string, label: string, val: string, verified: boolean, hint?: string) => (
    <div className="flex flex-col gap-1">
      <Field label={label} htmlFor={`pf-${name}`} hint={hint}><textarea id={`pf-${name}`} name={name} rows={3} defaultValue={val} /></Field>
      <label className="flex items-center gap-1 text-[12px] text-fg"><input type="checkbox" name={`verify-${name}`} value="1" defaultChecked={verified} /> I confirm these are accurate and may be used in emails</label>
    </div>
  );
  return (
    <form action={saveProfileAction}>
      <Section title="Verified candidate profile" actions={<Button variant="primary" type="submit">Save profile</Button>}>
        <p className="mb-3 text-[12px] text-muted">Drafts and AI prompts use only confirmed sections. Nothing here is invented for you; leave a section unconfirmed if unsure. One item per line.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name" htmlFor="pf-name"><input id="pf-name" name="name" defaultValue={d.name} /></Field>
          <Field label="Contact email (for signature)" htmlFor="pf-email"><input id="pf-email" name="email" defaultValue={d.email} /></Field>
          {area("education", "Education", (d.education ?? []).map((x) => x.text).join("\n"), v(d.education))}
          {area("skills", "Genuine skills", (d.skills ?? []).map((x) => x.text).join("\n"), v(d.skills))}
          {area("projects", "Projects", (d.projects ?? []).map((x) => `${x.name} — ${x.summary}${x.skills?.length ? ` | ${x.skills.join(", ")}` : ""}`).join("\n"), v(d.projects), "Format: Name — one-line summary | skill, skill")}
          {area("achievements", "Achievements", (d.achievements ?? []).map((x) => x.text).join("\n"), v(d.achievements))}
          {area("availability", "Availability", d.availability?.text ?? "", !!d.availability?.verified, "e.g. from June to August 2027")}
          {area("workAuthorization", "Work authorisation / visa facts", d.workAuthorization?.text ?? "", !!d.workAuthorization?.verified, "Only state what is true; this is never inferred.")}
          {area("statements", "Approved personal statements", (d.statements ?? []).map((x) => x.text).join("\n"), v(d.statements))}
          <Field label="Signature (HTML)" htmlFor="pf-sig"><textarea id="pf-sig" name="signatureHtml" rows={3} defaultValue={d.signatureHtml} /></Field>
        </div>
      </Section>
    </form>
  );
}

async function Sequences({ ownerId }: { ownerId: string }) {
  const db = getDb();
  const [seqs, tpls] = await Promise.all([db.select().from(s.sequences).where(eq(s.sequences.ownerId, ownerId)), db.select().from(s.templates).where(eq(s.templates.ownerId, ownerId))]);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Section title="Sequences">
        {seqs.map((q) => <div key={q.id} className="mb-2 text-[13px]"><strong>{q.name}</strong><ul className="text-[12px]">{(q.followups as FollowupStep[]).map((f) => <li key={f.step}>Follow-up {f.step}: {f.delayDays} days after the previous recorded send — {tpls.find((t) => t.id === f.templateId)?.name ?? "template"}</li>)}</ul></div>)}
        <p className="text-[11px] text-muted">Follow-ups are created as in-thread reply drafts for your review and pause automatically on replies, rejections, opt-outs, bounces, interviews, closure or manual pause. If mailbox sync is stale they are held until a fresh sync. There is always a small unavoidable window between the last mailbox check and submission in which a just-arrived reply cannot be seen.</p>
      </Section>
      <Section title="New sequence">
        <form action={saveSequenceAction} className="flex flex-col gap-2">
          <Field label="Name" htmlFor="sq-n"><input id="sq-n" name="name" required /></Field>
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-2">
              <Field label={`Follow-up ${i}: days after previous`} htmlFor={`sq-d${i}`}><input id={`sq-d${i}`} name={`delay-${i}`} type="number" min={0} defaultValue={i === 1 ? 7 : i === 2 ? 10 : 0} className="w-20" /></Field>
              <Field label="Template" htmlFor={`sq-t${i}`}><select id={`sq-t${i}`} name={`tpl-${i}`}><option value="">—</option>{tpls.filter((t) => t.kind !== "initial").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            </div>
          ))}
          <Button variant="primary" type="submit">Save sequence</Button>
        </form>
      </Section>
    </div>
  );
}
