import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { CATEGORY_LABEL } from "@/domain/mail/classify";
import { Badge, Button, Empty, fmtDate, PageHeader, Section } from "@/components/ui";
import { Flash } from "@/components/flash";
import { syncNowAction } from "@/app/actions/inbox";

export const metadata = { title: "Inbox" };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const convs = await db.select({ c: s.conversations, co: s.companies }).from(s.conversations).leftJoin(s.companies, eq(s.companies.id, s.conversations.companyId)).where(eq(s.conversations.ownerId, owner.id)).orderBy(desc(s.conversations.lastMessageAt)).limit(300);
  const ids = convs.map((x) => x.c.id);
  const msgs = ids.length ? await db.select().from(s.messages).where(inArray(s.messages.conversationId, ids)) : [];
  const folders = await db.select({ f: s.mailboxFolders, m: s.mailboxes }).from(s.mailboxFolders).innerJoin(s.mailboxes, eq(s.mailboxes.id, s.mailboxFolders.mailboxId)).where(eq(s.mailboxes.ownerId, owner.id));
  const filter = sp.filter ?? "all";
  const list = convs.filter(({ c }) => {
    const ms = msgs.filter((m) => m.conversationId === c.id);
    const lastIn = ms.filter((m) => m.direction === "inbound").sort((a, b) => (b.receivedAt?.getTime() ?? 0) - (a.receivedAt?.getTime() ?? 0))[0];
    if (filter === "review") return c.matchStatus === "ambiguous" || ms.some((m) => m.needsReview);
    if (filter === "human") return lastIn && !lastIn.isAutomated && !lastIn.isBounce;
    if (filter === "unread") return c.unreadCount > 0;
    return true;
  });
  return (
    <>
      <PageHeader title="Inbox" subtitle="Linked conversations only — unrelated mail is not imported." actions={<form action={syncNowAction}><Button type="submit">Sync now</Button></form>} />
      <Flash sp={sp} />
      <div className="mb-3 text-[12px] text-muted">
        Coverage: {folders.length === 0 ? "no mailbox folders yet." : folders.filter((x) => x.f.tracked).map((x) => `${x.f.displayName} (${x.m.emailAddress}) last synced ${x.f.lastSyncedAt ? fmtDate(x.f.lastSyncedAt, st.displayTimezone) : "never"}`).join(" · ")}
        {folders.some((x) => !x.f.tracked && x.f.role === "other") && <> · Untracked folders: {folders.filter((x) => !x.f.tracked).map((x) => x.f.displayName).join(", ")} — <Link href="/settings#mailboxes">track more</Link> if mail rules move replies there.</>}
      </div>
      <nav className="mb-2 flex gap-1" aria-label="Inbox filters">{[["all", "All"], ["human", "Human replies"], ["unread", "Unread"], ["review", "Needs review"]].map(([k, l]) => <Link key={k} href={`/inbox?filter=${k}`} aria-current={filter === k ? "page" : undefined} className={`rounded-md px-2.5 py-1 text-[13px] no-underline ${filter === k ? "bg-surface-2 font-semibold text-fg" : "text-muted"}`}>{l}</Link>)}</nav>
      {list.length === 0 ? <Empty title="No conversations">Replies appear here after the worker syncs your mailbox.</Empty> : (
        <Section title={`${list.length} conversations`}>
          <table className="data"><thead><tr><th>Company / contact</th><th>Subject</th><th>Latest</th><th>Category</th><th>Match</th></tr></thead>
            <tbody>{list.map(({ c, co }) => {
              const ms = msgs.filter((m) => m.conversationId === c.id);
              const lastIn = ms.filter((m) => m.direction === "inbound").sort((a, b) => (b.receivedAt?.getTime() ?? 0) - (a.receivedAt?.getTime() ?? 0))[0];
              return (
                <tr key={c.id} className={c.unreadCount ? "font-semibold" : ""}>
                  <td>{co?.name ?? <span className="text-warn">unassigned</span>}{c.unreadCount > 0 && <span className="ml-1"><Badge tone="info">{c.unreadCount} unread</Badge></span>}</td>
                  <td><Link href={`/inbox/${c.id}`}>{c.subject ?? "(no subject)"}</Link><div className="text-[11px] font-normal text-muted">{ms.length} messages</div></td>
                  <td className="text-[12px] font-normal">{fmtDate(c.lastMessageAt, st.displayTimezone)}</td>
                  <td>{lastIn?.category ? <Badge tone={lastIn.category === "positive_interest" ? "ok" : lastIn.category === "rejection" || lastIn.category === "bounce" ? "danger" : "neutral"} title={`${lastIn.categorySource} suggestion${lastIn.categoryConfidence ? `, ${Math.round(lastIn.categoryConfidence * 100)}%` : ""}`}>{CATEGORY_LABEL[lastIn.category as keyof typeof CATEGORY_LABEL] ?? lastIn.category}{lastIn.categorySource !== "manual" ? " ?" : ""}</Badge> : "—"}</td>
                  <td>{c.matchStatus === "ambiguous" ? <Badge tone="warn">review</Badge> : <span className="text-[12px] font-normal text-muted">{c.matchStatus}</span>}</td>
                </tr>
              );
            })}</tbody></table>
        </Section>
      )}
    </>
  );
}
