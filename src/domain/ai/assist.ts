/**
 * Direct AI assistance (optional). Every call is recorded in ai_jobs with
 * usage (actual when the provider reports it, otherwise an estimate) and is
 * gated by a monthly token budget. Results are suggestions; nothing here can
 * approve or send.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Services } from "../services";
import { buildTemplateValues } from "../outreach/personalize";
import { estimateTokens, extractJson } from "@/providers/ai/types";
import { errorSummary } from "@/lib/redact";

export class AiBudgetError extends Error {}

const SYSTEM = "You assist a mechanical engineering student with internship outreach. You only produce suggestions for the student to review. Never invent qualifications, metrics, work authorization, experience, contacts or company facts. Reply with JSON only.";

async function budgetCheck(svc: Services, ownerId: string, provider: string, estimate: number) {
  const [cred] = await svc.db.select().from(s.providerCredentials).where(and(eq(s.providerCredentials.ownerId, ownerId), eq(s.providerCredentials.provider, provider)));
  const budget = Number((cred?.config as { monthlyTokenBudget?: number } | undefined)?.monthlyTokenBudget ?? 0);
  if (!budget) return;
  const monthStart = new Date(Date.UTC(svc.clock.now().getUTCFullYear(), svc.clock.now().getUTCMonth(), 1));
  const [{ used }] = await svc.db.select({ used: sql<number>`coalesce(sum(coalesce(${s.aiJobs.inputTokens},0) + coalesce(${s.aiJobs.outputTokens},0)),0)::int` }).from(s.aiJobs).where(and(eq(s.aiJobs.ownerId, ownerId), eq(s.aiJobs.provider, provider), gte(s.aiJobs.createdAt, monthStart)));
  if (used + estimate > budget) throw new AiBudgetError(`Monthly AI token budget (${budget}) would be exceeded (used ${used}, this request ≈${estimate}).`);
}

export async function runAiTask<T>(svc: Services, ownerId: string, task: string, args: { instruction: string; untrusted?: string; provider?: string; input?: Record<string, unknown> }): Promise<{ result: T; jobId: string }> {
  const ai = await svc.ai(ownerId, args.provider);
  if (!ai) throw new Error("No AI provider is configured. Use the manual exchange (Imports & Exports → AI exchange) instead.");
  const estimate = estimateTokens(SYSTEM + args.instruction + (args.untrusted ?? "")) + 1500;
  try {
    await budgetCheck(svc, ownerId, ai.kind, estimate);
  } catch (e) {
    await svc.db.insert(s.aiJobs).values({ ownerId, provider: ai.kind, model: ai.model, task, status: "blocked_budget", input: args.input ?? {}, error: (e as Error).message });
    throw e;
  }
  const [job] = await svc.db.insert(s.aiJobs).values({ ownerId, provider: ai.kind, model: ai.model, task, input: args.input ?? {} }).returning();
  try {
    const r = await ai.complete({ task, system: SYSTEM, instruction: args.instruction, untrusted: args.untrusted });
    if (r.refused) throw new Error("The model declined this request.");
    const result = extractJson<T>(r.text);
    await svc.db.update(s.aiJobs).set({ status: "completed", result: result as object, inputTokens: r.inputTokens, outputTokens: r.outputTokens, usageIsEstimate: r.usageIsEstimate, model: r.model }).where(eq(s.aiJobs.id, job.id));
    return { result, jobId: job.id };
  } catch (e) {
    await svc.db.update(s.aiJobs).set({ status: "failed", error: errorSummary(e) }).where(eq(s.aiJobs.id, job.id));
    throw e;
  }
}

export async function aiDraftEmail(svc: Services, ownerId: string, companyId: string, contactId: string | null) {
  const { values, company } = await buildTemplateValues(svc.db, { ownerId, companyId, contactId });
  const evidence = await svc.db.select().from(s.companyEvidence).where(and(eq(s.companyEvidence.companyId, companyId), eq(s.companyEvidence.approvedForDrafting, true)));
  const facts = {
    company: company?.name, contactFirstName: values["contact.first_name"], myName: values["me.name"], project: values.project, skill: values.skill, availability: values.availability,
    companyFact: company?.engineeringActivity ?? null,
    evidence: evidence.slice(0, 8).map((e) => ({ id: e.id, summary: e.summary, url: e.url })),
  };
  return runAiTask<{ subject: string; bodyHtml: string; unsupportedClaims: string[]; usedFacts?: string[] }>(svc, ownerId, "draft_email", {
    instruction: `Draft a concise (120–180 words) internship enquiry email using only these approved facts. Return JSON {"subject","bodyHtml","unsupportedClaims":[]}.\nFACTS_JSON: ${JSON.stringify(facts)} END_FACTS`,
    input: { companyId, contactId },
  });
}

export async function aiClassifyReply(svc: Services, ownerId: string, messageId: string) {
  const [m] = await svc.db.select().from(s.messages).where(and(eq(s.messages.id, messageId), eq(s.messages.ownerId, ownerId)));
  const r = await runAiTask<{ category: string; confidence: number; rationale: string }>(svc, ownerId, "classify_reply", {
    instruction: 'Classify the reply as one of: positive_interest, question_request, referral, rejection, out_of_office, automated_ack, unsubscribe, uncertain. Return JSON {"category","confidence","rationale"}.',
    untrusted: `${m.subject ?? ""}\n\n${(m.bodyText ?? "").slice(0, 6000)}`,
    input: { messageId },
  });
  // Stored as an AI suggestion; a manual category is never overwritten.
  if (m.categorySource !== "manual") await svc.db.update(s.messages).set({ category: r.result.category, categorySource: "ai", categoryConfidence: r.result.confidence }).where(eq(s.messages.id, m.id));
  return r.result;
}

export async function aiSummarizeConversation(svc: Services, ownerId: string, conversationId: string) {
  const msgs = await svc.db.select().from(s.messages).where(and(eq(s.messages.conversationId, conversationId), eq(s.messages.ownerId, ownerId)));
  const text = msgs.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1)).map((m) => `[${m.direction}] ${m.subject ?? ""}\n${(m.bodyText ?? "").slice(0, 2000)}`).join("\n---\n");
  const r = await runAiTask<{ summary: string; nextAction: string; followupDraft: string | null }>(svc, ownerId, "summarize", { instruction: 'Summarise this conversation and suggest the next action. Return JSON {"summary","nextAction","followupDraft"}.', untrusted: text, input: { conversationId } });
  await svc.db.update(s.conversations).set({ summary: r.result.summary }).where(eq(s.conversations.id, conversationId));
  return r.result;
}

export async function aiSuggestCv(svc: Services, ownerId: string, companyId: string) {
  const [co] = await svc.db.select().from(s.companies).where(eq(s.companies.id, companyId));
  const docs = await svc.db.select().from(s.documents).where(and(eq(s.documents.ownerId, ownerId), eq(s.documents.archived, false)));
  return runAiTask<{ documentId: string | null; reason: string }>(svc, ownerId, "suggest_cv", {
    instruction: `Pick the best CV for this company. Return JSON {"documentId","reason"}.\nFACTS_JSON: ${JSON.stringify({ company: co.name, industry: co.industryPrimary, activity: co.engineeringActivity, cvs: docs.map((d) => ({ id: d.id, title: d.title, tags: d.industryTags, description: d.description })) })} END_FACTS`,
    input: { companyId },
  });
}
