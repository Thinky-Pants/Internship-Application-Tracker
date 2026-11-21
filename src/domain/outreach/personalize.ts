/**
 * Build template values from records. Only VERIFIED candidate-profile items are
 * used; unverified ones are ignored so drafts never assert unsupported claims.
 */
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import type { DbOrTx } from "@/db/client";

export interface ProfileItem {
  text: string;
  verified: boolean;
}
export interface CandidateProfile {
  name?: string;
  email?: string;
  education?: ProfileItem[];
  skills?: ProfileItem[];
  projects?: { name: string; summary: string; skills?: string[]; verified: boolean }[];
  achievements?: ProfileItem[];
  availability?: ProfileItem;
  statements?: ProfileItem[];
  workAuthorization?: ProfileItem;
  signatureHtml?: string;
}

export async function loadProfile(db: DbOrTx, ownerId: string): Promise<CandidateProfile> {
  const [p] = await db.select().from(s.candidateProfile).where(eq(s.candidateProfile.ownerId, ownerId));
  return (p?.data ?? {}) as CandidateProfile;
}

function pickProject(profile: CandidateProfile, industry: string | null) {
  const verified = (profile.projects ?? []).filter((p) => p.verified);
  if (!verified.length) return null;
  const ind = (industry ?? "").toLowerCase();
  return verified.find((p) => (p.skills ?? []).some((sk) => ind.includes(sk.toLowerCase())) || p.summary.toLowerCase().includes(ind.split(" ")[0] ?? "")) ?? verified[0];
}

export async function buildTemplateValues(db: DbOrTx, args: { ownerId: string; companyId: string | null; contactId: string | null; opportunityId?: string | null; personalization?: string | null }) {
  const profile = await loadProfile(db, args.ownerId);
  const [co] = args.companyId ? await db.select().from(s.companies).where(and(eq(s.companies.id, args.companyId), eq(s.companies.ownerId, args.ownerId))) : [];
  const [ct] = args.contactId ? await db.select().from(s.contacts).where(eq(s.contacts.id, args.contactId)) : [];
  const [op] = args.opportunityId ? await db.select().from(s.opportunities).where(eq(s.opportunities.id, args.opportunityId)) : [];
  const project = pickProject(profile, co?.industryPrimary ?? null);
  const skill = (profile.skills ?? []).find((x) => x.verified)?.text ?? null;
  const first = ct?.firstName ?? ct?.fullName?.split(/\s+/)[0] ?? null;
  return {
    values: {
      "company.name": co?.name ?? null,
      "company.industry": co?.industryPrimary ?? null,
      "company.city": co?.city ?? null,
      "company.country": co?.country ?? null,
      "contact.first_name": first,
      "contact.full_name": ct?.fullName ?? null,
      "contact.title": ct?.title ?? null,
      role: op?.roleTitle ?? "a summer 2027 mechanical engineering internship",
      project: project ? `${project.name} — ${project.summary}` : null,
      skill,
      availability: profile.availability?.verified ? profile.availability.text : null,
      personalization: args.personalization ?? null,
      "me.name": profile.name ?? null,
      signature: profile.signatureHtml ?? (profile.name ? `<p>${profile.name}</p>` : null),
    } as Record<string, string | null>,
    profile,
    company: co ?? null,
    contact: ct ?? null,
  };
}
