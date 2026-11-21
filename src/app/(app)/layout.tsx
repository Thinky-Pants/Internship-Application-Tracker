import Link from "next/link";
import { Suspense } from "react";
import { desc, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { logoutAction } from "../actions/auth";
import { NavLinks } from "@/components/nav";
import { isDemoMode } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const owner = await requireOwner();
  const db = getDb();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const [beat] = await db.select().from(s.workerHeartbeats).orderBy(desc(s.workerHeartbeats.lastBeatAt)).limit(1);
  const ageSec = beat ? Math.round((Date.now() - beat.lastBeatAt.getTime()) / 1000) : null;
  const workerOk = ageSec != null && ageSec < 60;
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="px-3 py-3">
          <Link href="/" className="font-semibold text-fg no-underline">Outreach Manager</Link>
          {isDemoMode() && <div className="mt-1 rounded bg-[var(--st-purple)]/15 px-1.5 py-0.5 text-[11px] font-medium text-[var(--st-purple)]">DEMO — mock providers, nothing is really sent</div>}
        </div>
        <nav aria-label="Main navigation"><Suspense fallback={null}><NavLinks /></Suspense></nav>
        <div className="mt-auto border-t border-line p-3 text-[11px] text-muted">
          <div className="flex items-center gap-1.5" title={beat ? `Last heartbeat ${ageSec}s ago` : "No worker heartbeat recorded"}>
            <span aria-hidden className={workerOk ? "text-ok" : "text-danger"}>●</span>
            Worker {workerOk ? "running" : beat ? `silent ${ageSec}s` : "not running"}
          </div>
          <div className="mt-1 truncate">{owner.displayName || owner.email}</div>
          <form action={logoutAction}><button className="mt-1 text-[11px] text-accent underline" type="submit">Sign out</button></form>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <nav className="flex gap-2 overflow-x-auto border-b border-line bg-surface p-2 md:hidden" aria-label="Main navigation (compact)"><Suspense fallback={null}><NavLinks compact /></Suspense></nav>
        {st?.globalPause && (
          <div role="status" className="border-b border-[var(--st-yellow)] bg-surface px-4 py-1.5 text-[13px]">
            <strong>Sending is paused globally</strong>{st.globalPauseReason ? ` — ${st.globalPauseReason}` : ""}. <Link href="/schedule">Manage in Schedule & Queue</Link>
          </div>
        )}
        {!workerOk && (
          <div role="status" className="border-b border-[var(--st-red)] bg-surface px-4 py-1.5 text-[13px]">
            The background worker is not running, so scheduled emails will not be sent and mail will not sync until it is started (<code>npm run worker</code>, or the worker service in your deployment).
          </div>
        )}
        <main id="main" className="mx-auto max-w-[1400px] p-4">{children}</main>
      </div>
    </div>
  );
}
