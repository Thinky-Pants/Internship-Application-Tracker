/**
 * Deterministic Apollo mock. Behaviour is derived from the domain so tests and
 * the demo are repeatable, and it never spends credits:
 *  - *.nomatch.*  → no people
 *  - *.blocked.*  → access denied
 *  - *.slow.*     → timeout
 *  - *.throttle.* → rate limited (retry after 30s)
 *  - otherwise 2–3 people; the first has a verified email on enrichment,
 *    the second "catch-all"/unverified, the third has none (search said
 *    has_email=true but enrichment reveals nothing).
 */
import { sha256Hex } from "@/lib/crypto";
import { ApolloError, type ApolloEnrichResult, type ApolloPersonCandidate, type ApolloProvider, type ApolloSearchInput } from "./types";

const PEOPLE = [
  { first: "Maya", last: "Lindqvist", title: "Co-founder & CTO", seniority: "founder" },
  { first: "Tomas", last: "Reyes", title: "Head of Mechanical Engineering", seniority: "head" },
  { first: "Aiko", last: "Tanaka", title: "Talent Partner", seniority: "manager" },
];

export class MockApolloProvider implements ApolloProvider {
  readonly kind = "mock_apollo" as const;
  calls: { op: string; arg: string }[] = [];

  async searchPeople(input: ApolloSearchInput) {
    this.calls.push({ op: "search", arg: input.domain });
    const d = input.domain.toLowerCase();
    if (d.includes(".blocked.") || d.startsWith("blocked.")) throw new ApolloError("access_denied", "Mock: plan does not include People API Search.");
    if (d.includes(".slow.") || d.startsWith("slow.")) throw new ApolloError("timeout", "Mock: request timed out.");
    if (d.includes(".throttle.") || d.startsWith("throttle.")) throw new ApolloError("rate_limited", "Mock: rate limited.", 30);
    if (d.includes(".nomatch.") || d.startsWith("nomatch.")) return { candidates: [], total: 0 };
    const n = 2 + (parseInt(sha256Hex(d).slice(0, 2), 16) % 2);
    const candidates: ApolloPersonCandidate[] = PEOPLE.slice(0, n).map((p, i) => ({
      apolloPersonId: `mock-${sha256Hex(d).slice(0, 8)}-${i}`,
      firstName: p.first,
      lastName: p.last.slice(0, 1) + "***",
      fullName: `${p.first} ${p.last}`,
      title: p.title,
      seniority: p.seniority,
      departments: ["engineering"],
      organizationName: d.split(".")[0],
      organizationId: `mock-org-${sha256Hex(d).slice(0, 8)}`,
      organizationDomain: d,
      linkedinUrl: null,
      personLocation: i === 0 ? "Remote — Lisbon, Portugal" : null, // contact location ≠ company location
      hasEmailFlag: true,
    }));
    return { candidates, total: candidates.length };
  }

  async enrichPerson(input: { apolloPersonId: string; domain?: string | null }): Promise<ApolloEnrichResult> {
    this.calls.push({ op: "enrich", arg: input.apolloPersonId });
    const idx = Number(input.apolloPersonId.split("-").pop());
    const domain = input.domain ?? "example.test";
    const p = PEOPLE[idx] ?? PEOPLE[0];
    if (idx === 2) return { apolloPersonId: input.apolloPersonId, email: null, emailStatus: "unavailable", matchConfidence: "medium", creditsConsumed: 0, raw: {} };
    return {
      apolloPersonId: input.apolloPersonId,
      email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@${domain}`,
      emailStatus: idx === 0 ? "verified" : "unverified",
      matchConfidence: "high",
      creditsConsumed: 1,
      raw: {},
    };
  }
}
