/**
 * Sheet roles and column mapping. Headers are matched case/spacing-insensitively
 * against synonyms; the user can override every suggestion in the UI and save
 * the mapping for reuse (keyed by a header signature).
 */
import { sha256Hex } from "@/lib/crypto";

export type SheetRole = "companies" | "evidence" | "apollo_contacts" | "ignore";
export type Priority = "primary" | "reserve" | "lead" | "other";

export const PRIORITY_RANK: Record<Priority, number> = { primary: 4, reserve: 3, lead: 2, other: 1 };

export interface FieldDef {
  key: string;
  label: string;
  synonyms: string[];
  list?: boolean;
}

export const COMPANY_FIELDS: FieldDef[] = [
  { key: "externalId", label: "Company ID", synonyms: ["company_id", "lead_id", "id", "external_id", "record_id"] },
  { key: "name", label: "Company name", synonyms: ["company_name", "company", "name", "organization", "organisation", "organization_name", "employer"] },
  { key: "originalName", label: "Original-language name", synonyms: ["original_language_name", "native_name", "local_name"] },
  { key: "website", label: "Website", synonyms: ["website_url", "website", "url", "homepage", "web", "company_website"] },
  { key: "domain", label: "Domain", synonyms: ["canonical_domain", "domain", "company_domain", "website_domain"] },
  { key: "description", label: "Description", synonyms: ["what_they_build", "description", "summary", "about"] },
  { key: "sizeText", label: "Size / employees", synonyms: ["employee_count_or_range", "size_if_listed", "employees", "size", "headcount", "company_size", "employee_count"] },
  { key: "fitScore", label: "Fit score", synonyms: ["fit_score", "score"] },
  { key: "matchTier", label: "Match tier", synonyms: ["match_tier", "tier"] },
  { key: "industryPrimary", label: "Primary industry", synonyms: ["primary_industry", "industry", "sector"] },
  { key: "industrySecondary", label: "Secondary industry", synonyms: ["secondary_industry"] },
  { key: "tags", label: "Tags (list)", synonyms: ["sector_tags", "tags", "keywords"], list: true },
  { key: "regionGroup", label: "Region group", synonyms: ["geographical_group", "region", "geo_group", "geography"] },
  { key: "country", label: "Country", synonyms: ["hq_country_or_territory", "country", "hq_country", "country_or_territory", "location_country"] },
  { key: "city", label: "City", synonyms: ["hq_city", "city", "location_city", "town"] },
  { key: "engineeringLocation", label: "Engineering location", synonyms: ["engineering_location", "engineering_site"] },
  { key: "lat", label: "Latitude", synonyms: ["lat", "latitude"] },
  { key: "lng", label: "Longitude", synonyms: ["lng", "lon", "long", "longitude"] },
  { key: "engineeringActivity", label: "Engineering activity", synonyms: ["engineering_activity"] },
  { key: "potentialInternWork", label: "Potential intern work", synonyms: ["potential_intern_work"] },
  { key: "internshipEvidence", label: "Internship evidence", synonyms: ["internship_evidence_status"] },
  { key: "careersUrl", label: "Careers URL", synonyms: ["careers_url", "careers", "jobs_url"] },
  { key: "opportunityUrl", label: "Opportunity URL", synonyms: ["opportunity_url", "job_url", "posting_url"] },
  { key: "eligibilityStatus", label: "International eligibility", synonyms: ["international_eligibility_status", "eligibility"] },
  { key: "eligibilityNotes", label: "Eligibility notes", synonyms: ["eligibility_notes"] },
  { key: "foundedText", label: "Founded", synonyms: ["founding_date_or_year", "founded_year_if_listed", "founded", "founded_year", "year_founded"] },
  { key: "notes", label: "Notes", synonyms: ["notes", "comments"] },
  { key: "researchNotes", label: "Research / review notes", synonyms: ["review_notes", "research_notes", "confidence_explanation"] },
  { key: "importedOutreachStatus", label: "Imported outreach status (historical)", synonyms: ["outreach_status", "status", "contacted"] },
  { key: "sourceAsOf", label: "Last verified date", synonyms: ["last_verified_date", "date_added", "updated", "last_updated"] },
  { key: "contactName", label: "Contact name", synonyms: ["contact_name", "contact", "person"] },
  { key: "contactTitle", label: "Contact title", synonyms: ["contact_title", "title", "job_title"] },
  { key: "contactEmail", label: "Contact email", synonyms: ["contact_email", "email", "email_address", "e_mail"] },
];

export const EVIDENCE_FIELDS: FieldDef[] = [
  { key: "evidenceId", label: "Source ID", synonyms: ["source_id", "evidence_id"] },
  { key: "companyExternalId", label: "Company ID", synonyms: ["company_id"] },
  { key: "fieldSupported", label: "Field supported", synonyms: ["field_supported", "field"] },
  { key: "url", label: "Source URL", synonyms: ["source_url", "url", "link"] },
  { key: "publisher", label: "Publisher", synonyms: ["publisher", "source_name"] },
  { key: "publishedDate", label: "Publication date", synonyms: ["source_publication_or_update_date", "published", "publication_date"] },
  { key: "accessedDate", label: "Accessed date", synonyms: ["accessed_date", "accessed"] },
  { key: "summary", label: "Evidence summary", synonyms: ["evidence_summary", "summary", "notes"] },
];

export const APOLLO_CONTACT_FIELDS: FieldDef[] = [
  { key: "firstName", label: "First name", synonyms: ["first_name"] },
  { key: "lastName", label: "Last name", synonyms: ["last_name"] },
  { key: "fullName", label: "Full name", synonyms: ["name", "full_name", "person_name"] },
  { key: "title", label: "Title", synonyms: ["title", "job_title"] },
  { key: "seniority", label: "Seniority", synonyms: ["seniority"] },
  { key: "departments", label: "Departments", synonyms: ["departments", "department"] },
  { key: "companyName", label: "Company / organization", synonyms: ["company", "company_name", "organization_name", "account_name"] },
  { key: "companyDomain", label: "Company website / domain", synonyms: ["website", "company_website", "domain", "company_domain", "organization_domain"] },
  { key: "email", label: "Email", synonyms: ["email", "email_address", "work_email"] },
  { key: "emailStatus", label: "Email status", synonyms: ["email_status", "email_confidence"] },
  { key: "emailVerifiedAt", label: "Email verification date", synonyms: ["email_last_verified_at", "email_verified_at", "last_verified", "email_verification_date"] },
  { key: "personCity", label: "Person city", synonyms: ["city"] },
  { key: "personState", label: "Person state", synonyms: ["state"] },
  { key: "personCountry", label: "Person country", synonyms: ["country"] },
  { key: "companyCity", label: "Company city", synonyms: ["company_city"] },
  { key: "companyState", label: "Company state", synonyms: ["company_state"] },
  { key: "companyCountry", label: "Company country", synonyms: ["company_country"] },
  { key: "linkedinUrl", label: "LinkedIn URL", synonyms: ["person_linkedin_url", "linkedin_url", "linkedin"] },
  { key: "apolloPersonId", label: "Apollo contact/person ID", synonyms: ["apollo_contact_id", "apollo_person_id", "person_id", "contact_id", "id"] },
  { key: "apolloOrgId", label: "Apollo account/organization ID", synonyms: ["apollo_account_id", "apollo_organization_id", "organization_id", "account_id"] },
];

export function fieldsForRole(role: SheetRole): FieldDef[] {
  if (role === "companies") return COMPANY_FIELDS;
  if (role === "evidence") return EVIDENCE_FIELDS;
  if (role === "apollo_contacts") return APOLLO_CONTACT_FIELDS;
  return [];
}

export function normHeader(h: string | null | undefined): string {
  return String(h ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Mapping: field key → column index (or null). */
export type ColumnMapping = Record<string, number | null>;

export function suggestMapping(headers: (string | null)[], role: SheetRole): ColumnMapping {
  const fields = fieldsForRole(role);
  const normed = headers.map(normHeader);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  // Pass 1: exact synonym in priority order; pass 2: contains.
  for (const f of fields) {
    let idx = -1;
    for (const syn of f.synonyms) {
      idx = normed.findIndex((h, i) => h === syn && !used.has(i));
      if (idx >= 0) break;
    }
    if (idx >= 0) {
      mapping[f.key] = idx;
      used.add(idx);
    } else mapping[f.key] = null;
  }
  for (const f of fields) {
    if (mapping[f.key] != null) continue;
    const idx = normed.findIndex((h, i) => !used.has(i) && h.length > 3 && f.synonyms.some((s) => s.length > 3 && (h.includes(s) || s.includes(h))));
    if (idx >= 0) {
      mapping[f.key] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

export interface SheetSuggestion {
  role: SheetRole;
  priority: Priority;
  reason: string;
}

export function suggestSheetRole(name: string, headers: (string | null)[]): SheetSuggestion {
  const n = name.toLowerCase();
  const hs = new Set(headers.map(normHeader));
  if (hs.has("source_id") && hs.has("company_id")) return { role: "evidence", priority: "other", reason: "Has Source_ID and Company_ID columns (research evidence)." };
  const looksApollo = (hs.has("first_name") && hs.has("last_name") && (hs.has("email") || hs.has("email_status"))) || [...hs].some((h) => h.startsWith("apollo_"));
  if (looksApollo) return { role: "apollo_contacts", priority: "other", reason: "Looks like an Apollo contact export." };
  const hasCompany = [...hs].some((h) => ["company_name", "company", "name", "organization_name"].includes(h));
  if (!hasCompany) return { role: "ignore", priority: "other", reason: "No company-name column found (summary/log/dictionary sheet)." };
  if (/reserve/.test(n)) return { role: "companies", priority: "reserve", reason: "Sheet name suggests reserve companies." };
  if (/lead/.test(n)) return { role: "companies", priority: "lead", reason: "Sheet name suggests unverified leads." };
  if (/compan|primary|target/.test(n)) return { role: "companies", priority: "primary", reason: "Sheet name suggests the primary company list." };
  return { role: "companies", priority: "other", reason: "Has a company-name column." };
}

export function headerSignature(headers: (string | null)[]): string {
  return sha256Hex(headers.map(normHeader).join("|")).slice(0, 24);
}

export interface SheetConfig {
  sheet: string;
  role: SheetRole;
  priority: Priority;
  headerRow: number; // 0-based
  mapping: ColumnMapping;
}

/** Extract a mapped record from a row. Missing columns → undefined. */
export function extractRecord(row: (string | null)[], mapping: ColumnMapping): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, idx] of Object.entries(mapping)) {
    if (idx == null) continue;
    out[k] = row[idx] ?? null;
  }
  return out;
}

export function rowToObject(headers: (string | null)[], row: (string | null)[]): Record<string, string | null> {
  const o: Record<string, string | null> = {};
  headers.forEach((h, i) => {
    const key = h ?? `Column ${i + 1}`;
    o[key] = row[i] ?? null;
  });
  return o;
}
