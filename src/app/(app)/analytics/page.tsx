import Link from "next/link";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import { dashboardMetrics, responseRates, type Dimension } from "@/domain/analytics";
import { PageHeader, Section, Stat, Badge } from "@/components/ui";

export const metadata = { title: "Analytics" };
const DIMS: Dimension[] = ["industry", "region", "priority", "template", "cv", "campaign"];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const dim = (DIMS.includes(sp.dim as Dimension) ? sp.dim : "industry") as Dimension;
  const days = Number(sp.days ?? 365);
  const db = getDb();
  const [m, rates] = await Promise.all([dashboardMetrics(db, owner.id), responseRates(db, owner.id, dim, days)]);
  const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const maxRate = Math.max(0.01, ...rates.rows.map((r) => r.replyRate ?? 0));
  return (
    <>
      <PageHeader title="Analytics" subtitle="All counts are computed from records. Companies are counted once; contacts and messages are counted separately." />
      <Section title="Coverage">
        <div className="flex flex-wrap gap-2">
          <Stat label="Distinct companies" value={m.companies} href="/companies" />
          <Stat label="Primary" value={m.byPriority.primary} href="/companies?priority=primary" />
          <Stat label="Reserve" value={m.byPriority.reserve} href="/companies?priority=reserve" />
          <Stat label="Leads" value={m.byPriority.lead} href="/companies?priority=lead" />
          <Stat label="Not researched" value={m.notResearched} href="/companies?discovery=not_researched" />
          <Stat label="Without email" value={m.withoutEmail} href="/companies?email=missing" />
          <Stat label="Any address" value={m.withAnyAddress} href="/companies?email=available" />
          <Stat label="Usable address" value={m.withUsable} href="/companies?email=usable" />
          <Stat label="Provider-verified" value={m.withVerified} href="/companies?email=verified" />
        </div>
      </Section>
      <Section title="Outreach & messages" className="mt-3">
        <div className="flex flex-wrap gap-2">
          <Stat label="Companies contacted" value={m.contacted} />
          <Stat label="Awaiting human reply" value={m.awaitingReply} href="/companies?progress=contacted" />
          <Stat label="Interviewing / offer" value={m.interviewing} href="/companies?progress=interviewing" />
          <Stat label="Closed" value={m.closed} />
          <Stat label="Scheduled" value={m.messages.scheduled} href="/schedule?view=queue&state=scheduled" />
          <Stat label="Submitted (not yet confirmed)" value={m.messages.submitted} />
          <Stat label="Recorded sent" value={m.messages.recordedSent} />
          <Stat label="Bounced" value={m.messages.bounced} />
          <Stat label="Failed" value={m.messages.failed} />
          <Stat label="Uncertain" value={m.messages.uncertain} />
        </div>
      </Section>
      <Section title="Discovery & usage" className="mt-3">
        <div className="flex flex-wrap gap-2">
          <Stat label="Companies searched" value={m.discoveryCoverage} />
          {Object.entries(m.enrichmentOutcomes).map(([k, v]) => <Stat key={k} label={`Enrich: ${k.replace(/_/g, " ")}`} value={v} />)}
          <Stat label="Apollo credits (actual)" value={m.creditsActual} />
          <Stat label="Apollo credits (estimated)" value={m.creditsEstimated} hint="where Apollo did not report usage" />
          <Stat label="AI tokens" value={m.aiTokens.toLocaleString()} hint={`${m.aiTokensEstimated.toLocaleString()} estimated`} />
        </div>
      </Section>
      <Section title="Response rates" className="mt-3" actions={<span className="flex flex-wrap gap-1 text-[12px]">{DIMS.map((d) => <Link key={d} href={`/analytics?dim=${d}&days=${days}`} aria-current={dim === d ? "page" : undefined} className={dim === d ? "font-semibold" : ""}>{d}</Link>)} · {[30, 90, 365].map((d) => <Link key={d} href={`/analytics?dim=${dim}&days=${d}`} className={days === d ? "font-semibold" : ""}>{d}d</Link>)}</span>}>
        <p className="mb-2 text-[12px] text-muted">Window: {rates.window}. Denominator: {rates.denominator}. Human replies exclude automated acknowledgements, out-of-office and bounces. Open tracking is not used. Small samples are marked; differences between groups do not establish cause.</p>
        {rates.rows.length === 0 ? <p className="text-[13px] text-muted">No sent outreach in this window yet.</p> : (
          <table className="data">
            <thead><tr><th>{dim}</th><th>Contacted (n)</th><th>Human replies</th><th>Reply rate</th><th>Positive</th><th>Positive rate</th><th></th></tr></thead>
            <tbody>{rates.rows.map((r) => (
              <tr key={r.key}>
                <td>{r.key}</td><td className="tabular-nums">{r.contacted}</td><td className="tabular-nums">{r.humanReplies}</td>
                <td><div className="flex items-center gap-2"><span className="w-10 tabular-nums">{pct(r.replyRate)}</span><span aria-hidden className="inline-block h-2 rounded bg-[var(--st-purple)]" style={{ width: `${((r.replyRate ?? 0) / maxRate) * 120}px` }} /></div></td>
                <td className="tabular-nums">{r.positive}</td><td className="tabular-nums">{pct(r.positiveRate)}</td>
                <td>{r.smallSample && <Badge tone="warn">small sample</Badge>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
    </>
  );
}
