/**
 * Apollo contract. People search and enrichment are separate operations:
 * search returns people (and at most a has_email flag) but never an address;
 * only enrichment (or a CSV export) can provide a usable address.
 */
export interface ApolloPersonCandidate {
  apolloPersonId: string;
  firstName: string | null;
  lastName: string | null;   // may be obfuscated in search results
  fullName: string;
  title: string | null;
  seniority: string | null;
  departments: string[];
  organizationName: string | null;
  organizationId: string | null;
  organizationDomain: string | null;
  linkedinUrl: string | null;
  personLocation: string | null;   // the PERSON's location — never written to company location
  hasEmailFlag: boolean | null;    // informational only; NOT an address
}

export interface ApolloSearchInput {
  domain: string;
  titles?: string[];
  seniorities?: string[];
  perPage?: number;
  page?: number;
}

export interface ApolloEnrichResult {
  apolloPersonId: string;
  email: string | null;
  emailStatus: string | null;      // provider label verbatim
  matchConfidence: string | null;
  creditsConsumed: number | null;  // actual when exposed, else null
  raw: Record<string, unknown>;
}

export type ApolloErrorKind = "auth_error" | "access_denied" | "rate_limited" | "timeout" | "insufficient_info" | "error";

export class ApolloError extends Error {
  constructor(public kind: ApolloErrorKind, message: string, public retryAfterSeconds?: number, public code?: string) {
    super(message);
    this.name = "ApolloError";
  }
}

export interface ApolloProvider {
  readonly kind: "apollo" | "mock_apollo";
  searchPeople(input: ApolloSearchInput): Promise<{ candidates: ApolloPersonCandidate[]; total: number }>;
  enrichPerson(input: { apolloPersonId: string; domain?: string | null; revealPersonalEmails?: false }): Promise<ApolloEnrichResult>;
}

/** Map Apollo email_status → our quality without upgrading uncertain states. */
export function qualityFromApolloStatus(status: string | null | undefined): "provider_verified" | "catch_all" | "invalid" | "unknown" {
  const s = (status ?? "").toLowerCase().trim();
  if (s === "verified") return "provider_verified";
  if (s.includes("catch") || s === "accept_all" || s === "accept all") return "catch_all";
  if (s === "invalid" || s === "bounced") return "invalid";
  // unverified, likely to engage, extrapolated, guessed, user_managed, unavailable, … stay unknown
  return "unknown";
}
