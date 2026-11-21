import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { listCompanies, parseFilter, filterOptions, filterQuery, type CompanyFilter } from "@/server/queries";
import { FilterBar } from "@/components/filter-bar";
import { PROGRESS_STYLE, PageHeader, Section } from "@/components/ui";
import type { OutreachProgress } from "@/domain/summary";

export const metadata = { title: "Pipeline" };
const COLS: OutreachProgress[] = ["not_contacted", "drafting", "ready", "scheduled", "contacted", "replied", "interviewing", "closed"];
const STAGES = ["prospect", "applied_contacted", "screening", "interview", "offer", "rejected", "withdrawn", "closed"];

export default async function PipelinePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const f = parseFilter(sp);
  const db = getDb();
  const [rows, options, views, opps] = await Promise.all([
    listCompanies(owner.id, f),
    filterOptions(owner.id),
    db.select().from(s.savedViews).where(and(eq(s.savedViews.ownerId, owner.id), eq(s.savedViews.view, "/pipeline"))),
    db.select({ o: s.opportunities, co: s.companies }).from(s.opportunities).innerJoin(s.companies, eq(s.companies.id, s.opportunities.companyId)).where(eq(s.opportunities.ownerId, owner.id)),
  ]);
  return (
    <>
      <PageHeader title="Pipeline" subtitle="Outreach progress per company (derived) and opportunity stages (one company can have several opportunities)." />
      <FilterBar f={f} options={options} action="/pipeline" views={views.map((v) => ({ id: v.id, name: v.name, qs: filterQuery(v.filters as CompanyFilter) }))} />
      <div className="grid gap-2 overflow-x-auto md:grid-cols-4 xl:grid-cols-8">
        {COLS.map((col) => {
          const items = rows.filter((r) => r.summary.outreach === col);
          const st = PROGRESS_STYLE[col];
          return (
            <section key={col} className="min-w-[160px] rounded-lg border border-line bg-surface" aria-label={st.label}>
              <h2 className="flex items-center justify-between border-b border-line px-2 py-1.5 text-[12px] font-semibold" style={{ borderTop: `3px solid ${st.color}` }}>
                <span><span aria-hidden>{st.glyph} </span>{st.label}</span><Link href={`/companies${filterQuery({ ...f, progress: col })}`} className="tabular-nums">{items.length}</Link>
              </h2>
              <ul className="max-h-[520px] overflow-y-auto p-1 text-[12px]">{items.slice(0, 60).map(({ company: c }) => <li key={c.id} className="truncate border-b border-line py-0.5"><Link href={`/companies/${c.id}`}>{c.name}</Link></li>)}{items.length > 60 && <li className="py-1 text-muted">+{items.length - 60} more</li>}</ul>
            </section>
          );
        })}
      </div>
      <Section title="Opportunity stages" className="mt-3">
        <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-8">
          {STAGES.map((stage) => {
            const items = opps.filter((x) => x.o.stage === stage);
            return (
              <div key={stage} className="rounded-md border border-line p-1">
                <h3 className="text-[12px] font-semibold">{stage.replace(/_/g, " ")} ({items.length})</h3>
                <ul className="text-[12px]">{items.slice(0, 30).map(({ o, co }) => <li key={o.id} className="truncate"><Link href={`/companies/${co.id}`}>{co.name}</Link> <span className="text-muted">{o.roleTitle}</span></li>)}</ul>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
