import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { Badge, Button, Field, fmtDate, PageHeader, Section } from "@/components/ui";
import { Flash } from "@/components/flash";
import { uploadImportAction, resolveDuplicateAction, importAiResultsAction, decideAiResultAction } from "@/app/actions/imports";

export const metadata = { title: "Imports & Exports" };
const TABS = [["imports", "Imports"], ["duplicates", "Duplicate review"], ["exports", "Exports & backup"], ["ai", "AI exchange"]] as const;

export default async function ImportsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const tab = sp.tab ?? "imports";
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const zone = st.displayTimezone;
  return (
    <>
      <PageHeader title="Imports & Exports" subtitle="Bring in your workbook and Apollo exports; export filtered lists, history, schedules and full backups." />
      <Flash sp={sp} />
      <nav className="mb-3 flex gap-1" aria-label="Import sections">
        {TABS.map(([k, l]) => <Link key={k} href={`/imports?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`rounded-md px-2.5 py-1 text-[13px] no-underline ${tab === k ? "bg-surface-2 font-semibold text-fg" : "text-muted"}`}>{l}</Link>)}
      </nav>
      {tab === "imports" && <ImportsTab ownerId={owner.id} zone={zone} />}
      {tab === "duplicates" && <DuplicatesTab ownerId={owner.id} />}
      {tab === "exports" && <ExportsTab />}
      {tab === "ai" && <AiTab ownerId={owner.id} zone={zone} />}
    </>
  );
}

async function ImportsTab({ ownerId, zone }: { ownerId: string; zone: string }) {
  const batches = await getDb().select().from(s.importBatches).where(eq(s.importBatches.ownerId, ownerId)).orderBy(desc(s.importBatches.createdAt)).limit(50);
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section title="Upload" className="lg:col-span-1">
        <form action={uploadImportAction} className="flex flex-col gap-2" encType="multipart/form-data">
          <Field label="File (.xlsx or .csv, up to 25 MB)" htmlFor="file"><input id="file" name="file" type="file" accept=".xlsx,.csv" required /></Field>
          <Field label="Kind" htmlFor="kind">
            <select id="kind" name="kind"><option value="workbook">Company workbook / company CSV</option><option value="apollo_csv">Apollo contact CSV export</option></select>
          </Field>
          <Button variant="primary" type="submit">Upload & preview</Button>
          <p className="text-[11px] text-muted">Nothing is written until you review the preview and commit. Re-importing the same workbook updates records instead of duplicating them, and never erases newer notes, emails, schedules or verified data with empty or older values. <a href="/api/templates/workbook">Download a workbook template</a>.</p>
        </form>
      </Section>
      <Section title="Import history" className="lg:col-span-2">
        {batches.length === 0 ? <p className="text-[13px] text-muted">No imports yet.</p> : (
          <table className="data">
            <thead><tr><th>File</th><th>Kind</th><th>Status</th><th>Created</th><th>Result</th></tr></thead>
            <tbody>{batches.map((b) => {
              const r = b.report as Record<string, number>;
              return (
                <tr key={b.id}>
                  <td><Link href={`/imports/${b.id}`}>{b.filename}</Link></td>
                  <td>{b.kind.replace("_", " ")}</td>
                  <td><Badge tone={b.status === "committed" ? "ok" : b.status === "previewed" ? "info" : "warn"}>{b.status.replace(/_/g, " ")}</Badge></td>
                  <td>{fmtDate(b.createdAt, zone)}</td>
                  <td className="text-[12px]">{b.status === "committed" || b.status === "rolled_back" || b.status === "correction_needed" ? Object.entries(r).filter(([, v]) => typeof v === "number" && v > 0).map(([k, v]) => `${k} ${v}`).join(" · ") : "—"}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

async function DuplicatesTab({ ownerId }: { ownerId: string }) {
  const db = getDb();
  const dups = await db.select({ d: s.duplicateCandidates, c: s.companies }).from(s.duplicateCandidates).innerJoin(s.companies, eq(s.companies.id, s.duplicateCandidates.existingCompanyId)).where(and(eq(s.duplicateCandidates.ownerId, ownerId), eq(s.duplicateCandidates.status, "open")));
  return (
    <Section title={`Possible duplicates awaiting review (${dups.length})`}>
      <p className="mb-2 text-[12px] text-muted">These rows matched an existing company only weakly (name only, or a shared domain with a different name — e.g. parent/subsidiary). They were not merged.</p>
      {dups.length === 0 ? <p className="text-[13px] text-muted">Nothing to review.</p> : (
        <table className="data">
          <thead><tr><th>Incoming row</th><th>Existing company</th><th>Why flagged</th><th>Decision</th></tr></thead>
          <tbody>{dups.map(({ d, c }) => {
            const inc = d.incoming as { fields: Record<string, string>; sheet: string; rowNumber: number; externalId: string | null };
            return (
              <tr key={d.id}>
                <td>{inc.fields.name}<div className="text-[11px] text-muted">{inc.fields.domain ?? "no domain"} · {inc.sheet} row {inc.rowNumber}{inc.externalId ? ` · ${inc.externalId}` : ""}</div></td>
                <td><Link href={`/companies/${c.id}`}>{c.name}</Link><div className="text-[11px] text-muted">{c.domain}</div></td>
                <td className="text-[12px]">{d.reason}</td>
                <td className="flex flex-wrap gap-1">
                  {(["link", "separate", "dismiss"] as const).map((dec) => (
                    <form key={dec} action={resolveDuplicateAction}><input type="hidden" name="id" value={d.id} /><input type="hidden" name="decision" value={dec} /><Button type="submit">{dec === "link" ? "Same company" : dec === "separate" ? "Different company" : "Ignore row"}</Button></form>
                  ))}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </Section>
  );
}

function ExportsTab() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Section title="Exports (CSV, formula-injection safe)">
        <ul className="flex flex-col gap-1 text-[13px]">
          <li><a href="/api/exports/companies">All companies with derived status</a> — filtered exports are available from the Companies page.</li>
          <li><a href="/api/exports/contacts">Contacts and email addresses</a></li>
          <li><a href="/api/exports/outreach">Outreach history (messages with evidence source)</a></li>
          <li><a href="/api/exports/schedule">Schedule & queue (planned vs. actual timestamps)</a></li>
          <li><a href="/api/exports/import-template">CSV template for companies</a></li>
        </ul>
      </Section>
      <Section title="Portable backup">
        <p className="text-[13px]">A complete backup contains every table owned by you (JSON) plus all stored files (CVs, uploaded imports). Credentials stay encrypted and require the same APP_ENCRYPTION_KEY to be usable after restore.</p>
        <p className="mt-2"><a href="/api/backup" className="font-medium">Download full backup (.zip)</a></p>
        <p className="mt-1 text-[11px] text-muted">Restore with <code>npm run restore -- path/to/backup.zip</code> into an empty database (see docs/OPERATIONS.md). Database-level backups (pg_dump) are recommended for cloud deployments in addition.</p>
      </Section>
    </div>
  );
}

async function AiTab({ ownerId, zone }: { ownerId: string; zone: string }) {
  const db = getDb();
  const pending = await db.select({ r: s.aiExchangeResults, c: s.companies, p: s.aiExchangePackages }).from(s.aiExchangeResults).innerJoin(s.companies, eq(s.companies.id, s.aiExchangeResults.recordId)).innerJoin(s.aiExchangePackages, eq(s.aiExchangePackages.id, s.aiExchangeResults.packageId)).where(eq(s.aiExchangeResults.ownerId, ownerId)).orderBy(desc(s.aiExchangeResults.createdAt)).limit(100);
  const mailboxes = await db.select().from(s.mailboxes).where(eq(s.mailboxes.ownerId, ownerId));
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section title="1. Export a task package">
        <p className="mb-2 text-[12px] text-muted">Works with Claude, ChatGPT or Gemini in their own apps — no API key needed. The package includes stable IDs, record revisions, your verified profile, CV metadata, evidence, instructions, a ready-to-paste prompt and the expected result schema. It never includes mailbox content or credentials.</p>
        <form method="get" action="/api/ai-exchange/export" className="flex flex-col gap-2">
          <Field label="Task" htmlFor="task"><select id="task" name="task"><option value="draft_email">Draft emails</option><option value="contact_priorities">Contact-role priorities & missing research</option><option value="research_facts">Research facts (needs a browsing tool)</option><option value="suggest_cv">Suggest CV</option></select></Field>
          <Field label="Companies (filter, max 50)" htmlFor="flt"><select id="flt" name="filter"><option value="ready">Usable address, not contacted</option><option value="missing">Primary with no email</option><option value="all">Top 50 by priority</option></select></Field>
          <Button type="submit" variant="primary">Download package (.json)</Button>
        </form>
        <p className="mt-2 text-[11px]"><a href="/api/ai-exchange/sample">Sample package & result</a></p>
      </Section>
      <Section title="2. Import results" className="lg:col-span-2">
        <form action={importAiResultsAction} className="flex flex-col gap-2" encType="multipart/form-data">
          <Field label="Upload JSON/JSONL" htmlFor="aif"><input id="aif" name="file" type="file" accept=".json,.jsonl,.txt" /></Field>
          <Field label="…or paste" htmlFor="ait"><textarea id="ait" name="text" rows={4} placeholder='{"packageId": "...", "recordType": "company", "recordId": "...", "recordRevision": 1, "result": {...}}' /></Field>
          <Button type="submit">Validate & stage</Button>
        </form>
        <p className="mt-1 text-[11px] text-muted">Results are schema-validated, matched by stable IDs, rejected when the record changed (stale) or is unknown, and deduplicated. Accepting creates suggestions only — drafts still need your approval; AI research is stored as unreviewed evidence.</p>
        <table className="data mt-3">
          <thead><tr><th>Company</th><th>Task</th><th>Status</th><th>Issues</th><th>Decide</th></tr></thead>
          <tbody>{pending.map(({ r, c, p }) => (
            <tr key={r.id}>
              <td><Link href={`/companies/${c.id}`}>{c.name}</Link><div className="text-[11px] text-muted">{fmtDate(r.createdAt, zone)}</div></td>
              <td>{p.task}</td>
              <td><Badge tone={r.status === "pending" ? "info" : r.status === "accepted" ? "ok" : "warn"}>{r.status}</Badge></td>
              <td className="text-[12px]">{(r.issues as string[]).join(" ")}<details><summary className="cursor-pointer">result</summary><pre className="max-w-md overflow-x-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(r.result, null, 2).slice(0, 2000)}</pre></details></td>
              <td>{r.status === "pending" && (
                <form action={decideAiResultAction} className="flex flex-col gap-1">
                  <input type="hidden" name="id" value={r.id} />
                  {p.task === "draft_email" && <>
                    <label htmlFor={`mb-${r.id}`} className="sr-only">Mailbox</label>
                    <select id={`mb-${r.id}`} name="mailboxId">{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.emailAddress ?? m.provider}</option>)}</select>
                    <label htmlFor={`to-${r.id}`} className="sr-only">Recipient</label>
                    <input id={`to-${r.id}`} name="to" placeholder="recipient@company.com" />
                  </>}
                  <div className="flex gap-1"><Button name="decision" value="accept" type="submit">Accept</Button><Button name="decision" value="reject" type="submit">Reject</Button></div>
                </form>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
      </Section>
    </div>
  );
}
