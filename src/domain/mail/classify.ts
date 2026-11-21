/**
 * Rule-based reply classification (a suggestion, not ground truth). AI may
 * add a second suggestion; manual overrides always win and are preserved.
 */
export type ReplyCategory =
  | "positive_interest" | "question_request" | "referral" | "rejection" | "out_of_office"
  | "automated_ack" | "unsubscribe" | "bounce" | "uncertain";

export const CATEGORY_LABEL: Record<ReplyCategory, string> = {
  positive_interest: "Positive interest",
  question_request: "Question / request",
  referral: "Referral",
  rejection: "Rejection",
  out_of_office: "Out of office",
  automated_ack: "Automated acknowledgement",
  unsubscribe: "Unsubscribe / do not contact",
  bounce: "Bounce",
  uncertain: "Uncertain",
};

export interface Classification {
  category: ReplyCategory;
  confidence: number;
  isAutomated: boolean;
  isBounce: boolean;
  bouncedAddress: string | null;
  reason: string;
}

const has = (re: RegExp, s: string) => re.test(s);

export function classifyInbound(m: { from: string | null; subject: string | null; bodyText: string; headers?: Record<string, string> }): Classification {
  const subject = (m.subject ?? "").toLowerCase();
  const body = (m.bodyText ?? "").toLowerCase().slice(0, 6000);
  const from = (m.from ?? "").toLowerCase();
  const h = Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  const base = { isAutomated: false, isBounce: false, bouncedAddress: null as string | null };

  if (/^(mailer-daemon|postmaster|microsoftexchange)/.test(from) || has(/undeliverable|delivery status notification|delivery has failed|mail delivery failed|returned mail|could not be delivered/, subject)) {
    const addr = (m.bodyText.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)?.[1] ?? null)?.toLowerCase() ?? null;
    return { ...base, category: "bounce", confidence: 0.95, isAutomated: true, isBounce: true, bouncedAddress: addr, reason: "Sender/subject match a delivery-failure notice." };
  }
  const autoHeader = (h["auto-submitted"] && h["auto-submitted"] !== "no") || h["x-autoreply"] || h["x-autorespond"] || h["precedence"] === "auto_reply";
  if (has(/out of (the )?office|automatic reply|auto(matic)?[- ]?reply|on (annual )?leave|on vacation|away until|abwesenheit|absence/, subject + " " + body.slice(0, 400)) && (autoHeader || has(/automatic reply|out of office|auto-?reply/, subject))) {
    return { ...base, category: "out_of_office", confidence: 0.9, isAutomated: true, reason: "Auto-reply wording and/or Auto-Submitted header." };
  }
  if (autoHeader || has(/^(no-?reply|noreply|do-?not-?reply)/, from) || has(/we have received your (application|message|email)|thank you for (your )?(application|applying|contacting)|this is an automated/, body)) {
    return { ...base, category: "automated_ack", confidence: 0.75, isAutomated: true, reason: "Automated sender or acknowledgement wording." };
  }
  if (has(/unsubscribe|remove me|do not contact|don't contact|stop emailing|take me off/, body)) {
    return { ...base, category: "unsubscribe", confidence: 0.8, reason: "Opt-out wording." };
  }
  if (has(/unfortunately|not (currently )?(hiring|accepting|able to offer)|no (open )?positions|no internship|cannot offer|not a fit|decided not to|regret to inform|filled the position/, body)) {
    return { ...base, category: "rejection", confidence: 0.7, reason: "Decline wording." };
  }
  if (has(/(reach out|contact|speak|talk) (to|with) [a-z]+|forward(ed|ing)? (your|this) (email|cv|resume|message)|cc'?(ing|ed)|best person|right person|colleague/, body)) {
    return { ...base, category: "referral", confidence: 0.6, reason: "Mentions another person or forwarding." };
  }
  if (has(/interview|schedule a (call|chat|meeting)|available (for|to) (a )?(call|chat)|let'?s (talk|chat|meet)|interested in (your|you)|would love to|happy to (chat|talk)|send (me )?(your )?(availability|times)/, body)) {
    return { ...base, category: "positive_interest", confidence: 0.65, reason: "Interest/interview wording." };
  }
  if (body.includes("?") || has(/could you|can you|please (send|share|provide|let me know)|what (is|are) your/, body)) {
    return { ...base, category: "question_request", confidence: 0.55, reason: "Contains a question or request." };
  }
  return { ...base, category: "uncertain", confidence: 0.3, reason: "No rule matched confidently." };
}
