import Link from "next/link";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { listCompanies, parseFilter, filterOptions, filterQuery, describeFilter, type CompanyFilter } from "@/server/queries";
import { DEFAULT_ROLE_HEURISTICS } from "@/domain/discovery/service";
import { FilterBar } from "@/components/filter-bar";
import { Badge, Button, Field, fmtDate, LinkButton, PageHeader, Section, Stat } from "@/components/ui";
import { Flash } from "@/components/flash";
import { createDiscoveryJobAction, jobStateAction, batchEnrichAction, retryFailedAttemptsAction } from "@/app/actions/discovery";

export const metadata = { title: "Contacts & Email Discovery" };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const f: CompanyFilter = { email: "missing", ...parseFilter(sp) };
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const zone = st.displayTimezone;
  const [rows, options, views, jobs, cred] = await Promise.all([
    listCompanies(owner.id, f),
    filterOptions(owner.id),
    db.select().from(s.savedViews).where(and(eq(s.savedViews.ownerId, owner.id), eq(s.savedViews.view, "/contacts"))),
    db.select().from(s.discoveryJobs).where(eq(s.discoveryJobs.ownerId, owner.id)).orderBy(desc(s.discoveryJobs.createdAt)).limit(10),
    db.select().from(s.providerCredentials).where(and(eq(s.providerCredentials.ownerId, owner.id), eq(s.providerCredentials.provider, "apollo"))),
  ]);
  const withApollo = await db.select({ c: s.contacts, co: s.companies }).from(s.contacts).innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId)).where(and(eq(s.contacts.ownerId, owner.id), isNotNull(s.contacts.apolloPersonId)));
  const emails = withApollo.length ? await db.select({ c: s.emailAddresses.contactId }).from(s.emailAddresses).where(inArray(s.emailAddresses.contactId, withApollo.map((x) => x.c.id))) : [];
  const needEnrich = withApollo.filter((x) => !emails.some((e) => e.c === x.c.id));
  const counts = rows.reduce<Record<string, number>>((a, r) => ((a[r.company.discoveryStatus] = (a[r.company.discoveryStatus] ?? 0) + 1), a), {});
  const withDomain = rows.filter((r) => r.company.domain).length;
  const apolloReady = !!cred[0]?.secretEnc || process.env.DEMO_MODE === "1" || process.env.APOLLO_MODE === "mock";
  return (
    <>
      <PageHeader title="Contacts & Email Discovery" subtitle="Finding a person, obtaining an address, checking its quality and sending are separate steps." actions={<><LinkButton href="/imports">Import Apollo CSV</LinkButton><LinkButton href={`/companies${filterQuery(f)}`}>Table</LinkButton></>} />
      <Flash sp={sp} />
      <FilterBar f={f} options={options} action="/contacts" views={views.map((v) => ({ id: v.id, name: v.name, qs: filterQuery(v.filters as CompanyFilter) }))} />
      <div className="mb-3 flex flex-wrap gap-2">{Object.entries(counts).map(([k, v]) => <Stat key={k} label={k.replace(/_/g, " ")} value={v} />)}</div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Batch people search (Apollo API)">
          {!apolloReady && <p className="mb-2 text-[13px] text-warn">Apollo API is not configured — use the CSV workflow or add a key in Settings.</p>}
          <form action={createDiscoveryJobAction} className="flex flex-col gap-2">
            <input type="hidden" name="filter" value={JSON.stringify(f)} />
            <p className="text-[12px]"><strong>Pre-run summary:</strong> {rows.length} companies match “{describeFilter(f)}”; {withDomain} have a domain to search. People search is documented as 0 credits but counts toward rate limits. No enrichment (credit-using) happens in this step.</p>
            <div className="flex flex-wrap gap-2">
              <Field label="Max companies" htmlFor="dj-m"><input id="dj-m" name="max" type="number" min={1} max={500} defaultValue={Math.min(50, withDomain)} className="w-24" /></Field>
              <Field label="Request budget" htmlFor="dj-r"><input id="dj-r" name="requestBudget" type="number" min={0} defaultValue={Math.min(50, withDomain)} className="w-24" /></Field>
              <Field label="Max candidates per company" htmlFor="dj-p"><input id="dj-p" name="perCompany" type="number" min={1} max={25} defaultValue={5} className="w-20" /></Field>
            </div>
            <Field label="Titles" htmlFor="dj-t" hint={DEFAULT_ROLE_HEURISTICS.note}><input id="dj-t" name="titles" defaultValue={[...DEFAULT_ROLE_HEURISTICS.smallCompany.titles, ...DEFAULT_ROLE_HEURISTICS.engineering.titles.slice(0, 4)].join(", ")} /></Field>
            <Field label="Seniorities" htmlFor="dj-s"><input id="dj-s" name="seniorities" defaultValue="founder, owner, c_suite, head, director, manager" /></Field>
            <Button variant="primary" type="submit" disabled={!apolloReady || !withDomain}>Queue search job</Button>
          </form>
          <h3 className="mt-3 text-[12px] font-semibold">Jobs</h3>
          {jobs.length === 0 ? <p className="text-[12px] text-muted">None yet.</p> : (
            <table className="data"><thead><tr><th>Created</th><th>Status</th><th>Progress</th><th>Requests</th><th></th></tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.id}><td>{fmtDate(j.createdAt, zone)}</td><td><Badge>{j.status}</Badge></td><td className="tabular-nums">{j.doneItems}/{j.totalItems}</td><td className="tabular-nums">{j.requestsUsed}{j.requestBudget != null ? `/${j.requestBudget}` : ""}</td>
                  <td className="flex gap-1">{["pending", "running"].includes(j.status) && <form action={jobStateAction}><input type="hidden" name="jobId" value={j.id} /><input type="hidden" name="action" value="pause" /><Button type="submit">Pause</Button></form>}
                    {j.status === "paused" && <form action={jobStateAction}><input type="hidden" name="jobId" value={j.id} /><input type="hidden" name="action" value="resume" /><Button type="submit">Resume</Button></form>}
                    {!["completed", "cancelled"].includes(j.status) && <form action={jobStateAction}><input type="hidden" name="jobId" value={j.id} /><input type="hidden" name="action" value="cancel" /><Button variant="danger" type="submit">Cancel unstarted</Button></form>}</td></tr>
              ))}</tbody></table>
          )}
          <form action={retryFailedAttemptsAction} className="mt-2"><Button type="submit">Retry failed (timeouts/errors)</Button></form>
        </Section>
        <Section title={`Saved people without an address (${needEnrich.length})`}>
          <form action={batchEnrichAction}>
            <p className="mb-2 text-[12px] text-muted">Enrichment reveals business emails for selected people only. Apollo charges credits when data is returned; already-resolved or recently enriched people are skipped. Phone and personal emails are never requested.</p>
            <div className="mb-2 flex items-end gap-2"><Field label="Credit budget for this run" htmlFor="be-b"><input id="be-b" name="budget" type="number" min={0} defaultValue={Number((cred[0]?.config as { creditBudget?: number })?.creditBudget ?? 10)} className="w-24" /></Field><Button variant="primary" type="submit" disabled={!apolloReady}>Enrich selected</Button></div>
            <ul className="max-h-80 overflow-y-auto text-[13px]">{needEnrich.slice(0, 300).map(({ c, co }) => <li key={c.id}><label className="flex items-center gap-2 text-fg"><input type="checkbox" name="contactId" value={c.id} /> {c.fullName} <span className="text-muted">{c.title} · <Link href={`/companies/${co.id}`}>{co.name}</Link></span></label></li>)}</ul>
          </form>
        </Section>
      </div>
      <Section title={`Companies (${rows.length})`} className="mt-3">
        <table className="data"><thead><tr><th>Company</th><th>Priority</th><th>Discovery</th><th>Contacts</th><th>Last attempt</th></tr></thead>
          <tbody>{rows.slice(0, 200).map(({ company: c, summary }) => (
            <tr key={c.id}><td><Link href={`/companies/${c.id}#discovery`}>{c.name}</Link><div className="text-[11px] text-muted">{c.domain ?? "no domain"}</div></td><td>{c.priority}</td><td>{c.discoveryStatus.replace(/_/g, " ")}</td><td>{summary.contactCount}</td><td className="text-[12px]">{c.discoveryUpdatedAt ? fmtDate(c.discoveryUpdatedAt, zone) : "—"}</td></tr>
          ))}</tbody></table>
      </Section>
    </>
  );
}
