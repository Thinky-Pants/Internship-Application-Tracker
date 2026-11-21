/** Deterministic mock AI: echoes structured suggestions from the provided facts. Never calls a network. */
import { estimateTokens, type AiProvider, type AiRequest, type AiResponse } from "./types";

export class MockAiProvider implements AiProvider {
  readonly kind = "mock" as const;
  readonly model = "mock-deterministic-1";
  async complete(req: AiRequest): Promise<AiResponse> {
    let text: string;
    const facts = req.instruction.match(/FACTS_JSON:\s*(\{[\s\S]*?\})\s*END_FACTS/)?.[1];
    const f = facts ? (JSON.parse(facts) as Record<string, any>) : {};
    switch (req.task) {
      case "draft_email":
        text = JSON.stringify({
          subject: `Summer 2027 mechanical engineering internship — ${f.company ?? "your team"}`,
          bodyHtml: `<p>Dear ${f.contactFirstName ?? "Hiring Team"},</p><p>I am a mechanical engineering student and I am interested in ${f.company ?? "your company"}'s work${f.companyFact ? ` on ${f.companyFact}` : ""}.${f.project ? ` Recently I worked on ${f.project}.` : ""}</p><p>Would you consider me for a summer 2027 internship? My CV is attached.</p><p>Kind regards,<br>${f.myName ?? ""}</p>`,
          unsupportedClaims: [],
          usedFacts: Object.keys(f),
        });
        break;
      case "suggest_cv":
        text = JSON.stringify({ documentId: f.cvs?.[0]?.id ?? null, reason: f.cvs?.[0] ? `Tags of "${f.cvs[0].title}" overlap with the company's industry.` : "No CV uploaded." });
        break;
      case "classify_reply": {
        const body = String(req.untrusted ?? "").toLowerCase();
        const cat = /interview|call|chat/.test(body) ? "positive_interest" : /unfortunately|not hiring/.test(body) ? "rejection" : "uncertain";
        text = JSON.stringify({ category: cat, confidence: 0.6, rationale: "Mock keyword classification." });
        break;
      }
      case "summarize":
        text = JSON.stringify({ summary: String(req.untrusted ?? "").slice(0, 200), nextAction: "Review the latest message and reply.", followupDraft: null });
        break;
      case "contact_priorities":
        text = JSON.stringify({ roles: ["Founder/CTO", "Head of mechanical engineering", "Recruiter"], missingResearch: f.missing ?? [] });
        break;
      default:
        text = JSON.stringify({ note: "mock" });
    }
    return { text, model: this.model, inputTokens: estimateTokens(req.system + req.instruction + (req.untrusted ?? "")), outputTokens: estimateTokens(text), usageIsEstimate: true };
  }
}
