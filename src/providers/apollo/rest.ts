/**
 * Apollo REST adapter (server-side only; key never reaches the browser).
 * Verified against docs.apollo.io:
 *  - Auth header: x-api-key. The key needs these endpoints in its scope
 *    (403 otherwise; some keys require a master key).
 *  - People search: POST /api/v1/mixed_people/api_search — 0 credits, no emails
 *    or phones in the response (has_email flag only).
 *  - Enrichment: POST /api/v1/people/match — credits charged only when
 *    credit-consuming data is found; personal emails/phones off by default.
 *  - 429 with error_details.retry_after_seconds when rate limited.
 */
import { ApolloError, type ApolloEnrichResult, type ApolloPersonCandidate, type ApolloProvider, type ApolloSearchInput } from "./types";

const BASE = "https://api.apollo.io/api/v1";

export class ApolloRestProvider implements ApolloProvider {
  readonly kind = "apollo" as const;
  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch, private timeoutMs = 20_000) {}

  private async post<T>(path: string, query: URLSearchParams): Promise<T> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}?${query.toString()}`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "Content-Type": "application/json", "Cache-Control": "no-cache", Accept: "application/json" },
        body: "{}",
        signal: ac.signal,
      });
    } catch (e) {
      throw new ApolloError((e as Error).name === "AbortError" ? "timeout" : "error", `Apollo request failed: ${(e as Error).name}`);
    } finally {
      clearTimeout(t);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.ok) return body as T;
    const details = body.error_details ?? {};
    const msg = String(details.message ?? body.error ?? res.statusText).slice(0, 300);
    if (res.status === 401) throw new ApolloError("auth_error", `Apollo rejected the API key: ${msg}`, undefined, details.code);
    if (res.status === 403) throw new ApolloError("access_denied", `Apollo denied access (plan, key scope or master key required): ${msg}`, undefined, details.code);
    if (res.status === 429) throw new ApolloError("rate_limited", `Apollo rate limit: ${msg}`, Number(details.retry_after_seconds ?? res.headers.get("retry-after") ?? 60), details.code);
    if (res.status === 422 || res.status === 400) throw new ApolloError("insufficient_info", `Apollo could not process the request: ${msg}`, undefined, details.code);
    throw new ApolloError("error", `Apollo ${res.status}: ${msg}`, undefined, details.code);
  }

  async searchPeople(input: ApolloSearchInput) {
    const q = new URLSearchParams();
    q.append("q_organization_domains_list[]", input.domain);
    for (const t of input.titles ?? []) q.append("person_titles[]", t);
    for (const s of input.seniorities ?? []) q.append("person_seniorities[]", s);
    q.set("include_similar_titles", "true");
    q.set("per_page", String(Math.min(input.perPage ?? 10, 25)));
    q.set("page", String(input.page ?? 1));
    const body = await this.post<{ people?: any[]; total_entries?: number }>("/mixed_people/api_search", q);
    const candidates: ApolloPersonCandidate[] = (body.people ?? []).map((p) => {
      const id = String(p.id ?? p.person_id ?? "");
      const first = p.first_name ?? null;
      const last = p.last_name ?? p.last_name_obfuscated ?? null;
      return {
        apolloPersonId: id,
        firstName: first,
        lastName: last,
        fullName: [first, last].filter(Boolean).join(" ") || p.name || "(name withheld)",
        title: p.title ?? null,
        seniority: p.seniority ?? null,
        departments: p.departments ?? [],
        organizationName: p.organization?.name ?? null,
        organizationId: p.organization_id ?? p.organization?.id ?? null,
        organizationDomain: p.organization?.primary_domain ?? input.domain,
        linkedinUrl: p.linkedin_url ?? null,
        personLocation: [p.city, p.state, p.country].filter(Boolean).join(", ") || null,
        hasEmailFlag: typeof p.has_email === "boolean" ? p.has_email : null,
      };
    }).filter((c) => c.apolloPersonId);
    return { candidates, total: Number(body.total_entries ?? candidates.length) };
  }

  async enrichPerson(input: { apolloPersonId: string; domain?: string | null }): Promise<ApolloEnrichResult> {
    const q = new URLSearchParams({ id: input.apolloPersonId, reveal_personal_emails: "false", reveal_phone_number: "false" });
    if (input.domain) q.set("domain", input.domain);
    const body = await this.post<{ person?: Record<string, any>; credits_consumed?: number }>("/people/match", q);
    const p = body.person ?? null;
    if (!p) throw new ApolloError("insufficient_info", "Apollo returned no person for this ID.");
    const email = typeof p.email === "string" && p.email.includes("@") && !/^email_not_unlocked/i.test(p.email) ? p.email : null;
    return {
      apolloPersonId: String(p.id ?? input.apolloPersonId),
      email,
      emailStatus: p.email_status ?? null,
      matchConfidence: p.match_confidence ?? null,
      creditsConsumed: typeof body.credits_consumed === "number" ? body.credits_consumed : null,
      raw: { email_status: p.email_status ?? null, match_confidence: p.match_confidence ?? null, title: p.title ?? null },
    };
  }
}
