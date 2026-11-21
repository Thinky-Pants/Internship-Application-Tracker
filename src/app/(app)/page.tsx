import Link from "next/link";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { listCompanies } from "@/server/queries";
import { dashboardMetrics } from "@/domain/analytics";
import { CATEGORY_LABEL } from "@/domain/mail/classify";
import { Badge, Button, Empty, fmtDate, PageHeader, Section, Stat, StateBadge } from "@/components/ui";
import { Flash } from "@/components/flash";
import { completeTaskAction } from "../actions/companies";
import { saveTodayOrderAction } from "../actions/today";

export const metadata = { title: "Today" };
const SECTIONS = ["replies", "interviews", "sendIssues", "followups", "drafts", "tasks", "ready"] as const;
const LABEL: Record<(typeof SECTIONS)[number], string> = { replies: "Human replies needing action", interviews: "Interviews & deadlines", sendIssues: "Failed, uncertain or held sends", followups: "Follow-ups due for review", drafts: "Drafts awaiting review", tasks: "Reminders & tasks", ready: "High-priority companies ready for the next step" };

export default async function TodayPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const zone = st.displayTimezone;
  const now = new Date();
  const order = ((st.todayPriorities as { order?: string[] }).order ?? [...SECTIONS]).filter((x) => (SECTIONS as readonly string[]).includes(x)) as (typeof SECTIONS)[number][];

  const [replies, opps, issues, followups, drafts, tasks, ready, metrics] = await Promise.all([
    db.select({ m: s.messages, co: s.companies }).from(s.messages).leftJoin(s.companies, eq(s.companies.id, s.messages.companyId)).where(and(eq(s.messages.ownerId, owner.id), eq(s.messages.direction, "inbound"), eq(s.messages.isAutomated, false), eq(s.messages.isBounce, false), eq(s.messages.isRead, false))).orderBy(desc(s.messages.receivedAt)).limit(20),
    db.select({ o: s.opportunities, co: s.companies }).from(s.opportunities).innerJoin(s.companies, eq(s.companies.id, s.opportunities.companyId)).where(and(eq(s.opportunities.ownerId, owner.id), inArray(s.opportunities.stage, ["screening", "interview", "offer"]))).limit(20),
    db.select({ sd: s.scheduledSends, m: s.messages }).from(s.scheduledSends).innerJoin(s.messages, eq(s.messages.id, s.scheduledSends.messageId)).where(and(eq(s.scheduledSends.ownerId, owner.id), inArray(s.scheduledSends.state, ["failed", "uncertain", "held"]))).limit(20),
    db.select({ m: s.messages, co: s.companies }).from(s.messages).leftJoin(s.companies, eq(s.companies.id, s.messages.companyId)).where(and(eq(s.messages.ownerId, owner.id), eq(s.messages.kind, "followup"), inArray(s.messages.status, ["draft", "awaiting_approval"]))).limit(20),
    db.select({ m: s.messages, co: s.companies }).from(s.messages).leftJoin(s.companies, eq(s.companies.id, s.messages.companyId)).where(and(eq(s.messages.ownerId, owner.id), eq(s.messages.direction, "outbound"), inArray(s.messages.kind, ["initial", "reply"]), inArray(s.messages.status, ["draft", "awaiting_approval"]))).orderBy(desc(s.messages.updatedAt)).limit(20),
    db.select({ t: s.tasks, co: s.companies }).from(s.tasks).leftJoin(s.companies, eq(s.companies.id, s.tasks.companyId)).where(and(eq(s.tasks.ownerId, owner.id), eq(s.tasks.status, "open"), lte(s.tasks.dueAt, new Date(now.getTime() + 7 * 86400_000)))).orderBy(asc(s.tasks.dueAt)).limit(30),
    listCompanies(owner.id, { priority: "primary", email: "usable", progress: "not_contacted" }).then((r) => r.slice(0, 10)),
    dashboardMetrics(db, owner.id),
  ]);

  // Next action: first non-empty section in the configured order, with its reason.
  const next =
    order.map((k) => {
      if (k === "replies" && replies[0]) return { href: replies[0].m.conversationId ? `/inbox/${replies[0].m.conversationId}` : "/inbox", label: `Reply to ${replies[0].co?.name ?? replies[0].m.fromAddress}`, reason: "An unread human reply is waiting." };
      if (k === "interviews" && opps[0]) return { href: `/companies/${opps[0].co.id}`, label: `Prepare: ${opps[0].co.name} (${opps[0].o.stage})`, reason: "An active opportunity is in progress." };
      if (k === "sendIssues" && issues[0]) return { href: `/schedule?send=${issues[0].sd.id}&view=queue`, label: `Resolve ${issues[0].sd.state} send: ${issues[0].m.subject}`, reason: issues[0].sd.holdReason ?? issues[0].sd.lastError ?? "A send needs a decision." };
      if (k === "followups" && followups[0]) return { href: `/drafts/${followups[0].m.id}`, label: `Review follow-up for ${followups[0].co?.name}`, reason: "A follow-up draft is ready for review." };
      if (k === "drafts" && drafts[0]) return { href: `/drafts/${drafts[0].m.id}`, label: `Review draft for ${drafts[0].co?.name}`, reason: "A draft is waiting for approval." };
      if (k === "tasks" && tasks[0]) return { href: tasks[0].co ? `/companies/${tasks[0].co.id}` : "/", label: tasks[0].t.title, reason: tasks[0].t.dueAt && tasks[0].t.dueAt < now ? "This task is overdue." : "Due soon." };
      if (k === "ready" && ready[0]) return { href: `/drafts/new?companyId=${ready[0].company.id}`, label: `Draft for ${ready[0].company.name}`, reason: "Primary company with a usable address, not yet contacted." };
      return null;
    }).find(Boolean) ?? null;

  const blocks: Record<(typeof SECTIONS)[number], React.ReactNode> = {
    replies: replies.length ? <ul className="text-[13px]">{replies.map(({ m, co }) => <li key={m.id}><Link href={m.conversationId ? `/inbox/${m.conversationId}` : "/inbox"}>{co?.name ?? m.fromAddress}: {m.subject}</Link> {m.category && <Badge>{CATEGORY_LABEL[m.category as keyof typeof CATEGORY_LABEL] ?? m.category}</Badge>} <span className="text-muted">{fmtDate(m.receivedAt, zone)}</span></li>)}</ul> : null,
    interviews: opps.length ? <ul className="text-[13px]">{opps.map(({ o, co }) => <li key={o.id}><Link href={`/companies/${co.id}`}>{co.name}</Link> — {o.roleTitle} <Badge tone="ok">{o.stage}</Badge> {o.deadline && <span className="text-muted">deadline {o.deadline}</span>}</li>)}</ul> : null,
    sendIssues: issues.length ? <ul className="text-[13px]">{issues.map(({ sd, m }) => <li key={sd.id}><StateBadge state={sd.state} /> <Link href={`/schedule?send=${sd.id}&view=queue`}>{m.subject}</Link> <span className="text-muted">{sd.holdReason ?? sd.lastError}</span></li>)}</ul> : null,
    followups: followups.length ? <ul className="text-[13px]">{followups.map(({ m, co }) => <li key={m.id}><Link href={`/drafts/${m.id}`}>{co?.name}: {m.subject}</Link></li>)}</ul> : null,
    drafts: drafts.length ? <ul className="text-[13px]">{drafts.map(({ m, co }) => <li key={m.id}><Link href={`/drafts/${m.id}`}>{co?.name ?? "—"}: {m.subject || "(no subject)"}</Link> <StateBadge state={m.status} /></li>)}</ul> : null,
    tasks: tasks.length ? <ul className="text-[13px]">{tasks.map(({ t, co }) => <li key={t.id} className="flex items-center gap-2"><form action={completeTaskAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="back" value="/" /><Button type="submit" aria-label={`Mark done: ${t.title}`}>Done</Button></form><span className={t.dueAt && t.dueAt < now ? "text-danger" : ""}>{t.title}</span>{co && <Link href={`/companies/${co.id}`} className="text-[12px]">{co.name}</Link>}<span className="text-[11px] text-muted">{t.dueAt ? fmtDate(t.dueAt, zone, false) : ""}{t.dueAt && t.dueAt < now ? " (overdue)" : ""}</span></li>)}</ul> : null,
    ready: ready.length ? <ul className="text-[13px]">{ready.map(({ company: c }) => <li key={c.id}><Link href={`/companies/${c.id}`}>{c.name}</Link> <span className="text-muted">{c.country}{c.fitScore != null ? ` · fit ${c.fitScore}` : ""}</span> — <Link href={`/drafts/new?companyId=${c.id}`}>prepare draft</Link></li>)}</ul> : null,
  };

  return (
    <>
      <PageHeader title="Today" subtitle={new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "full" }).format(now) + ` (${zone})`} />
      <Flash sp={sp} />
      {metrics.companies === 0 ? (
        <Empty title="Welcome — start by importing your workbook"><Link href="/imports">Import companies</Link> · <Link href="/settings?setup=1">First-run setup</Link></Empty>
      ) : (
        <>
          {next && (
            <div className="mb-3 rounded-lg border border-accent bg-surface p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted">Next action</div>
              <Link href={next.href} className="text-[15px] font-semibold">{next.label} →</Link>
              <div className="text-[12px] text-muted">Why: {next.reason}</div>
            </div>
          )}
          <div className="mb-3 flex flex-wrap gap-2">
            <Stat label="Companies" value={metrics.companies} href="/companies" />
            <Stat label="Without email" value={metrics.withoutEmail} href="/companies?email=missing&priority=primary" hint="all priorities" />
            <Stat label="Usable, not contacted" value={(await listCompanies(owner.id, { email: "usable", progress: "not_contacted" })).length} href="/companies?email=usable&progress=not_contacted" />
            <Stat label="Awaiting reply" value={metrics.awaitingReply} href="/companies?progress=contacted" />
            <Stat label="Scheduled" value={metrics.messages.scheduled} href="/schedule" />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {order.map((k) => (
              <Section key={k} title={LABEL[k]}>{blocks[k] ?? <p className="text-[13px] text-muted">Nothing here.</p>}</Section>
            ))}
          </div>
          <details className="mt-3"><summary className="cursor-pointer text-[12px]">Edit Today priorities</summary>
            <form action={saveTodayOrderAction} className="mt-2 flex flex-wrap items-end gap-2">
              {SECTIONS.map((k) => <label key={k} className="flex flex-col text-[12px]">{LABEL[k]}<input type="number" name={k} min={1} max={9} defaultValue={order.indexOf(k) + 1 || 9} className="w-16" /></label>)}
              <Button type="submit">Save order</Button>
            </form>
          </details>
        </>
      )}
    </>
  );
}
