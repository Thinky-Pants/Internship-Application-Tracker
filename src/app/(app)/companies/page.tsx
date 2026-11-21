import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { listCompanies, parseFilter, filterOptions, filterQuery, type CompanyFilter } from "@/server/queries";
import { FilterBar } from "@/components/filter-bar";
import { Badge, Empty, LinkButton, PageHeader, ProgressBadge, QualityBadge } from "@/components/ui";
import { Flash } from "@/components/flash";

export const metadata = { title: "Companies" };
const PAGE = 100;

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const f = parseFilter(sp);
  const page = Math.max(1, Number(sp.page ?? 1));
  const [rows, options, views] = await Promise.all([
    listCompanies(owner.id, f),
    filterOptions(owner.id),
    getDb().select().from(s.savedViews).where(and(eq(s.savedViews.ownerId, owner.id), eq(s.savedViews.view, "/companies"))),
  ]);
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);
  const pages = Math.ceil(rows.length / PAGE);
  return (
    <>
      <PageHeader
        title="Companies"
        subtitle={`${rows.length} distinct companies match (counts are computed from records, not stored).`}
        actions={<>
          <LinkButton href={`/map${filterQuery(f)}`}>Show on map</LinkButton>
          <LinkButton href={`/api/exports/companies${filterQuery(f)}`}>Export CSV</LinkButton>
        </>}
      />
      <Flash sp={sp} />
      <FilterBar f={f} options={options} action="/companies" views={views.map((v) => ({ id: v.id, name: v.name, qs: filterQuery(v.filters as CompanyFilter) }))} />
      {rows.length === 0 ? (
        <Empty title="No companies match">Adjust the filters, or <Link href="/imports">import your workbook</Link>.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="data">
            <thead>
              <tr><th>Company</th><th>Priority</th><th>Industry</th><th>Location</th><th>Contacts</th><th>Email</th><th>Outreach</th><th>Discovery</th></tr>
            </thead>
            <tbody>
              {shown.map(({ company: c, summary: sm, location }) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/companies/${c.id}`} className="font-medium">{c.name}</Link>
                    {c.isDemo && <span className="ml-1"><Badge tone="purple">demo</Badge></span>}
                    {c.suppressed && <span className="ml-1"><Badge tone="danger">suppressed</Badge></span>}
                    <div className="text-[12px] text-muted">{c.domain ?? "no domain"}{c.fitScore != null ? ` · fit ${c.fitScore}` : ""}</div>
                  </td>
                  <td>{c.priority}</td>
                  <td className="text-[12px]">{c.industryPrimary ?? "—"}</td>
                  <td className="text-[12px]">{[c.city, c.country].filter(Boolean).join(", ") || "—"}{location?.precision === "country" && <div className="text-muted">approx. (country)</div>}</td>
                  <td className="tabular-nums">{sm.contactCount}</td>
                  <td>{sm.emailAvailability === "missing" ? <Badge>missing</Badge> : <QualityBadge quality={sm.bestQuality ?? "unknown"} />}</td>
                  <td><ProgressBadge p={sm.outreach} />{c.importedOutreachStatus && c.importedOutreachStatus !== "Not contacted" && <div className="text-[11px] text-muted" title="Imported text; not provider evidence">imported: {c.importedOutreachStatus}</div>}</td>
                  <td className="text-[12px]">{c.discoveryStatus.replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav className="mt-3 flex gap-2 text-[13px]" aria-label="Pagination">
          {page > 1 && <Link href={`/companies${filterQuery(f, { page: String(page - 1) })}`}>← Previous</Link>}
          <span className="text-muted">Page {page} of {pages}</span>
          {page < pages && <Link href={`/companies${filterQuery(f, { page: String(page + 1) })}`}>Next →</Link>}
        </nav>
      )}
    </>
  );
}
