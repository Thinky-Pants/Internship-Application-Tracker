/**
 * Analytics. Counting rules:
 *  - Companies are counted once regardless of how many contacts/messages.
 *  - "Contacted" = company has an outbound message recorded sent / submitted / sent from Outlook
 *    within the window. Rates use contacted companies as the denominator.
 *  - "Human reply" excludes automated replies, out-of-office and bounces.
 *  - "Positive" = a positive-interest reply or an opportunity in interview/offer.
 *  - Small samples (< 20 contacted companies) are flagged; differences do not imply causation.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import * as s from "@/db/schema";
import type { DbOrTx } from "@/db/client";
import { companySummaries } from "./summary";

export async function dashboardMetrics(db: DbOrTx, ownerId: string) {
  const comps = await db.select().from(s.companies).where(eq(s.companies.ownerId, ownerId));
  const sums = await companySummaries(db, ownerId);
  const all = [...sums.values()];
  const sends = await db.select({ state: s.scheduledSends.state }).from(s.scheduledSends).where(eq(s.scheduledSends.ownerId, ownerId));
  const bounced = await db.select({ id: s.messages.id }).from(s.messages).where(and(eq(s.messages.ownerId, ownerId), eq(s.messages.direction, "outbound"), eq(s.messages.isBounce, true)));
  const attempts = await db.select().from(s.discoveryAttempts).where(eq(s.discoveryAttempts.ownerId, ownerId));
  const ledger = await db.select().from(s.usageLedger).where(eq(s.usageLedger.ownerId, ownerId));
  const ai = await db.select().from(s.aiJobs).where(eq(s.aiJobs.ownerId, ownerId));
  const cnt = (st: string) => sends.filter((x) => x.state === st).length;
  const outcomes = attempts.filter((a) => a.kind === "enrich").reduce<Record<string, number>>((m, a) => ((m[a.outcome ?? a.status] = (m[a.outcome ?? a.status] ?? 0) + 1), m), {});
  const credits = ledger.filter((l) => l.unit === "credits");
  return {
    companies: comps.length,
    byPriority: { primary: comps.filter((c) => c.priority === "primary").length, reserve: comps.filter((c) => c.priority === "reserve").length, lead: comps.filter((c) => c.priority === "lead").length },
    notResearched: comps.filter((c) => c.discoveryStatus === "not_researched").length,
    withoutEmail: all.filter((x) => x.emailAvailability === "missing").length,
    withAnyAddress: all.filter((x) => x.emailAvailability === "available").length,
    withUsable: all.filter((x) => x.usableAddress).length,
    withVerified: all.filter((x) => x.bestQuality === "provider_verified").length,
    contacted: all.filter((x) => ["contacted", "replied", "interviewing", "closed"].includes(x.outreach) && x.contactedAt).length,
    awaitingReply: all.filter((x) => x.outreach === "contacted").length,
    interviewing: all.filter((x) => x.outreach === "interviewing").length,
    closed: all.filter((x) => x.outreach === "closed").length,
    messages: { scheduled: cnt("scheduled"), submitted: cnt("submitted"), recordedSent: cnt("recorded_sent"), bounced: bounced.length, failed: cnt("failed"), uncertain: cnt("uncertain"), held: cnt("held") },
    discoveryCoverage: new Set(attempts.filter((a) => a.status === "completed").map((a) => a.companyId)).size,
    enrichmentOutcomes: outcomes,
    creditsActual: credits.filter((c) => !c.isEstimate).reduce((a, c) => a + Number(c.amount), 0),
    creditsEstimated: credits.filter((c) => c.isEstimate).reduce((a, c) => a + Number(c.amount), 0),
    aiTokens: ai.reduce((a, j) => a + (j.inputTokens ?? 0) + (j.outputTokens ?? 0), 0),
    aiTokensEstimated: ai.filter((j) => j.usageIsEstimate).reduce((a, j) => a + (j.inputTokens ?? 0) + (j.outputTokens ?? 0), 0),
  };
}

export type Dimension = "industry" | "region" | "priority" | "template" | "cv" | "campaign";

export interface RateRow {
  key: string;
  contacted: number;
  humanReplies: number;
  positive: number;
  replyRate: number | null;
  positiveRate: number | null;
  smallSample: boolean;
}

export async function responseRates(db: DbOrTx, ownerId: string, dim: Dimension, sinceDays: number, now = new Date()): Promise<{ rows: RateRow[]; window: string; denominator: string }> {
  const since = new Date(now.getTime() - sinceDays * 86400_000);
  const out = await db.select().from(s.messages).where(and(eq(s.messages.ownerId, ownerId), eq(s.messages.direction, "outbound"), gte(s.messages.createdAt, since)));
  const sent = out.filter((m) => (m.recordedSentAt || m.submittedAt || m.kind === "external_sent") && m.companyId);
  const companyIds = [...new Set(sent.map((m) => m.companyId!))];
  const comps = companyIds.length ? await db.select().from(s.companies).where(inArray(s.companies.id, companyIds)) : [];
  const inbound = companyIds.length ? await db.select().from(s.messages).where(and(inArray(s.messages.companyId, companyIds), eq(s.messages.direction, "inbound"))) : [];
  const opps = companyIds.length ? await db.select().from(s.opportunities).where(inArray(s.opportunities.companyId, companyIds)) : [];
  const revIds = sent.map((m) => m.currentRevisionId!).filter(Boolean);
  const revs = revIds.length ? await db.select().from(s.messageRevisions).where(inArray(s.messageRevisions.id, revIds)) : [];
  const templates = await db.select().from(s.templates).where(eq(s.templates.ownerId, ownerId));
  const campaigns = await db.select().from(s.campaigns).where(eq(s.campaigns.ownerId, ownerId));
  const versions = await db.select({ v: s.documentVersions, d: s.documents }).from(s.documentVersions).innerJoin(s.documents, eq(s.documents.id, s.documentVersions.documentId)).where(eq(s.documents.ownerId, ownerId));

  // Each company is attributed to the dimension of its FIRST sent message in the window.
  const first = new Map<string, typeof sent[number]>();
  for (const m of [...sent].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) if (!first.has(m.companyId!)) first.set(m.companyId!, m);
  const keyFor = (cid: string) => {
    const m = first.get(cid)!;
    const co = comps.find((c) => c.id === cid);
    const rev = revs.find((r) => r.id === m.currentRevisionId);
    if (dim === "industry") return co?.industryPrimary ?? "Unknown";
    if (dim === "region") return co?.regionGroup ?? "Unknown";
    if (dim === "priority") return co?.priority ?? "other";
    if (dim === "template") return templates.find((t) => t.id === rev?.templateId)?.name ?? "No template";
    if (dim === "campaign") return campaigns.find((c) => c.id === m.campaignId)?.name ?? "No campaign";
    const att = (rev?.attachments as { documentVersionId: string }[] | undefined)?.[0];
    const v = versions.find((x) => x.v.id === att?.documentVersionId);
    return v ? `${v.d.title} v${v.v.versionNo}` : "No CV";
  };
  const groups = new Map<string, { contacted: Set<string>; human: Set<string>; positive: Set<string> }>();
  for (const cid of first.keys()) {
    const k = keyFor(cid);
    const g = groups.get(k) ?? { contacted: new Set(), human: new Set(), positive: new Set() };
    g.contacted.add(cid);
    const humans = inbound.filter((m) => m.companyId === cid && !m.isAutomated && !m.isBounce && m.category !== "out_of_office");
    if (humans.length) g.human.add(cid);
    if (humans.some((m) => m.category === "positive_interest") || opps.some((o) => o.companyId === cid && ["interview", "offer"].includes(o.stage))) g.positive.add(cid);
    groups.set(k, g);
  }
  const rows = [...groups.entries()].map(([key, g]) => ({
    key,
    contacted: g.contacted.size,
    humanReplies: g.human.size,
    positive: g.positive.size,
    replyRate: g.contacted.size ? g.human.size / g.contacted.size : null,
    positiveRate: g.contacted.size ? g.positive.size / g.contacted.size : null,
    smallSample: g.contacted.size < 20,
  })).sort((a, b) => b.contacted - a.contacted);
  return { rows, window: `last ${sinceDays} days (messages created since ${since.toISOString().slice(0, 10)})`, denominator: "distinct companies contacted in the window (attributed to their first message)" };
}
