/**
 * Company-level summaries are DERIVED from underlying records (never stored
 * as a single overwritten status). Rules (also in docs/ARCHITECTURE.md):
 *
 * Email availability
 *   available  = at least one address that is not suppressed, not hard-bounced
 *                and not marked invalid
 *   missing    = otherwise (a search hit without an address is still missing)
 * Best quality: provider_verified > catch_all > unknown (unverified). AI-guessed
 *   addresses count as available but never as "usable" for the default queue.
 * Usable = available and not an unverified AI guess.
 *
 * Outreach progress (first match wins)
 *   closed        company closed/suppressed, or every opportunity rejected/withdrawn/closed
 *   interviewing  any opportunity in interview/offer
 *   replied       any human (non-automated, non-bounce) inbound message
 *   contacted     any outbound message recorded sent / submitted, or sent from Outlook
 *   scheduled     an active scheduled send
 *   ready         an approved, unscheduled message
 *   drafting      an outbound draft exists
 *   not_contacted otherwise (imported "Outreach_Status" text is shown separately)
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";

export type OutreachProgress = "not_contacted" | "drafting" | "ready" | "scheduled" | "contacted" | "replied" | "interviewing" | "closed";

export interface CompanySummary {
  companyId: string;
  emailAvailability: "available" | "missing";
  bestQuality: "provider_verified" | "catch_all" | "unknown" | null;
  usableAddress: boolean;
  contactCount: number;
  outreach: OutreachProgress;
  lastActivityAt: Date | null;
  nextFollowupAt: Date | null;
  contactedAt: Date | null;
}

export const PROGRESS_LABEL: Record<OutreachProgress, string> = {
  not_contacted: "Not contacted",
  drafting: "Drafting",
  ready: "Ready (approved)",
  scheduled: "Scheduled",
  contacted: "Contacted — awaiting reply",
  replied: "Replied",
  interviewing: "Interview / offer",
  closed: "Closed",
};

const SUMMARY_SQL = (where: ReturnType<typeof sql>) => sql`
  SELECT c.id AS company_id,
    (SELECT count(*)::int FROM contacts ct WHERE ct.company_id = c.id) AS contact_count,
    (SELECT bool_or(e.quality = 'provider_verified') FROM email_addresses e WHERE e.company_id = c.id AND NOT e.suppressed AND e.bounce_state <> 'hard' AND e.quality <> 'invalid') AS has_verified,
    (SELECT bool_or(e.quality = 'catch_all') FROM email_addresses e WHERE e.company_id = c.id AND NOT e.suppressed AND e.bounce_state <> 'hard' AND e.quality <> 'invalid') AS has_catch_all,
    (SELECT count(*)::int FROM email_addresses e WHERE e.company_id = c.id AND NOT e.suppressed AND e.bounce_state <> 'hard' AND e.quality <> 'invalid') AS available_n,
    (SELECT count(*)::int FROM email_addresses e WHERE e.company_id = c.id AND NOT e.suppressed AND e.bounce_state <> 'hard' AND e.quality <> 'invalid' AND NOT (e.source = 'ai_guess' AND e.quality = 'unknown')) AS usable_n,
    (c.outreach_closed OR c.suppressed) AS closed_flag,
    (SELECT count(*)::int FROM opportunities o WHERE o.company_id = c.id) AS opp_n,
    (SELECT count(*)::int FROM opportunities o WHERE o.company_id = c.id AND o.stage IN ('rejected','withdrawn','closed')) AS opp_closed_n,
    (SELECT count(*)::int FROM opportunities o WHERE o.company_id = c.id AND o.stage IN ('interview','offer')) AS opp_interview_n,
    (SELECT count(*)::int FROM messages m WHERE m.company_id = c.id AND m.direction = 'inbound' AND NOT m.is_automated AND NOT m.is_bounce) AS human_replies,
    (SELECT min(coalesce(m.recorded_sent_at, m.submitted_at)) FROM messages m WHERE m.company_id = c.id AND m.direction = 'outbound' AND (m.status IN ('recorded_sent','submitted','uncertain') OR m.kind = 'external_sent')) AS contacted_at,
    (SELECT count(*)::int FROM scheduled_sends sd JOIN messages m ON m.id = sd.message_id WHERE m.company_id = c.id AND sd.state IN ('scheduled','held','paused','dispatching')) AS active_sends,
    (SELECT min(sd.planned_at) FROM scheduled_sends sd JOIN messages m ON m.id = sd.message_id WHERE m.company_id = c.id AND m.kind = 'followup' AND sd.state = 'scheduled') AS next_followup,
    (SELECT count(*)::int FROM messages m WHERE m.company_id = c.id AND m.direction = 'outbound' AND m.status = 'approved') AS approved_n,
    (SELECT count(*)::int FROM messages m WHERE m.company_id = c.id AND m.direction = 'outbound' AND m.status IN ('draft','awaiting_approval')) AS draft_n,
    (SELECT max(coalesce(m.received_at, m.recorded_sent_at, m.updated_at)) FROM messages m WHERE m.company_id = c.id) AS last_activity
  FROM companies c WHERE ${where}`;

function toSummary(r: Record<string, any>): CompanySummary {
  const outreach: OutreachProgress =
    r.closed_flag || (r.opp_n > 0 && r.opp_n === r.opp_closed_n) ? "closed"
    : r.opp_interview_n > 0 ? "interviewing"
    : r.human_replies > 0 ? "replied"
    : r.contacted_at ? "contacted"
    : r.active_sends > 0 ? "scheduled"
    : r.approved_n > 0 ? "ready"
    : r.draft_n > 0 ? "drafting"
    : "not_contacted";
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  return {
    companyId: r.company_id,
    emailAvailability: r.available_n > 0 ? "available" : "missing",
    bestQuality: r.available_n > 0 ? (r.has_verified ? "provider_verified" : r.has_catch_all ? "catch_all" : "unknown") : null,
    usableAddress: r.usable_n > 0,
    contactCount: r.contact_count,
    outreach,
    lastActivityAt: date(r.last_activity),
    nextFollowupAt: date(r.next_followup),
    contactedAt: date(r.contacted_at),
  };
}

async function run(db: DbOrTx, q: ReturnType<typeof sql>): Promise<Record<string, any>[]> {
  const res = (await db.execute(q)) as unknown as { rows?: Record<string, any>[] } | Record<string, any>[];
  return Array.isArray(res) ? res : res.rows ?? [];
}

export async function companySummary(db: DbOrTx, companyId: string): Promise<CompanySummary> {
  const rows = await run(db, SUMMARY_SQL(sql`c.id = ${companyId}`));
  if (!rows[0]) throw new Error("Company not found.");
  return toSummary(rows[0]);
}

export async function companySummaries(db: DbOrTx, ownerId: string): Promise<Map<string, CompanySummary>> {
  const rows = await run(db, SUMMARY_SQL(sql`c.owner_id = ${ownerId}`));
  return new Map(rows.map((r) => [r.company_id as string, toSummary(r)]));
}
