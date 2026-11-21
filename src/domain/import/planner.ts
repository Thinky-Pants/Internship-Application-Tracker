/**
 * Import planner (pure). Turns mapped sheet rows + a snapshot of existing
 * companies into a preview plan. The same function runs at preview and again
 * inside the commit transaction against fresh state.
 *
 * Matching rules (strongest first):
 *  1. Known external ID (Company_ID / Lead_ID / any alias)  → update
 *  2. Same domain, exactly one existing company, similar name → update
 *     Same domain but dissimilar name, or several companies share the domain
 *     (parents/subsidiaries)                                 → duplicate review
 *  3. Name-only match                                         → duplicate review
 *  4. Otherwise                                               → add
 * Within one import, a lower-priority sheet row that strongly matches an
 * earlier row (e.g. a Lead that was promoted into Companies) is merged into it:
 * it contributes an alias ID and fills empty fields only.
 *
 * Field update rules on reimport:
 *  - Empty incoming values never erase existing values.
 *  - Values last set manually (provenance "manual") are kept; differences are
 *    reported as conflicts the user may resolve field by field.
 *  - Values with a newer "as of" date than the incoming row are kept.
 *  - Priority is never downgraded by a lower-priority sheet in the same import.
 *  - importedOutreachStatus is stored as historical text only; it never creates
 *    messages or implies provider evidence. Emails never imply outreach.
 */
import {
  cleanKnown, cleanText, lookupCountry, normalizeCity, normalizeDomain, normalizeEmail, normalizeUrl, parseIntSafe, splitList,
} from "../normalize";
import { PRIORITY_RANK, extractRecord, rowToObject, type Priority, type SheetConfig } from "./mapping";

export const SCALAR_FIELDS = [
  "name", "originalName", "website", "domain", "description", "sizeText", "fitScore", "matchTier", "industryPrimary",
  "industrySecondary", "regionGroup", "country", "countryCode", "city", "engineeringLocation", "engineeringActivity",
  "potentialInternWork", "internshipEvidence", "careersUrl", "opportunityUrl", "eligibilityStatus", "eligibilityNotes",
  "foundedText", "notes", "researchNotes", "importedOutreachStatus", "priority",
] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];

export interface IncomingCompany {
  externalId: string | null;
  fields: Partial<Record<ScalarField, string | number | null>>;
  tags: string[];
  lat: number | null;
  lng: number | null;
  asOf: string | null;
  email: { address: string; contactName: string | null; contactTitle: string | null } | null;
  sourceRow: Record<string, string | null>;
}

export interface ExistingCompany {
  id: string;
  name: string;
  domain: string | null;
  externalIds: string[];
  fields: Partial<Record<ScalarField, string | number | null>>;
  provenance: Record<string, { source: string; at?: string; asOf?: string | null }>;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}
export interface FieldConflict {
  field: string;
  existing: unknown;
  incoming: unknown;
  reason: "manual_edit" | "newer_existing";
}

export type PlanAction = "add" | "update" | "unchanged" | "merge_in_batch" | "duplicate_review" | "invalid" | "evidence" | "evidence_unmatched";

export interface PlanRow {
  key: string;            // `${sheet}#${rowNumber}`
  sheet: string;
  rowNumber: number;      // 1-based spreadsheet row
  priority: Priority;
  action: PlanAction;
  targetCompanyId?: string;
  mergeIntoKey?: string;
  incoming?: IncomingCompany;
  changes: FieldChange[];
  conflicts: FieldConflict[];
  issues: string[];
  duplicate?: { companyId: string; companyName: string; reason: string };
  evidence?: EvidenceRecord;
  raw: Record<string, string | null>;
}

export interface EvidenceRecord {
  evidenceId: string | null;
  companyExternalId: string | null;
  fieldSupported: string | null;
  url: string | null;
  publisher: string | null;
  publishedDate: string | null;
  accessedDate: string | null;
  summary: string | null;
}

export interface ImportPlan {
  rows: PlanRow[];
  counts: Record<PlanAction, number> & { distinctCompaniesAfter: number; byPriority: Record<string, number> };
  sheets: { sheet: string; role: string; priority: Priority; dataRows: number }[];
}

const LEGAL = /\b(inc|incorporated|ltd|limited|llc|gmbh|ag|sa|sas|sarl|bv|nv|ab|as|asa|oy|oyj|aps|srl|spa|s\.p\.a|kk|co|corp|corporation|company|plc|pte|pty|technologies|technology|tech|robotics|systems|labs|group|holdings|有限公司|股份有限公司)\b\.?/g;

export function nameKey(name: string | null | undefined): string {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(LEGAL, " ").replace(/[^a-z0-9一-鿿]+/g, " ").trim();
}

export function namesSimilar(a: string, b: string): boolean {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb || ka.replace(/ /g, "") === kb.replace(/ /g, "")) return true;
  if (ka.length >= 4 && kb.length >= 4 && (ka.includes(kb) || kb.includes(ka))) return true;
  const ta = new Set(ka.split(" "));
  const tb = new Set(kb.split(" "));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / new Set([...ta, ...tb]).size >= 0.5;
}

function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function normalizeCompanyRecord(
  rec: Record<string, string | null>,
  priority: Priority,
  sourceRow: Record<string, string | null>,
): { incoming: IncomingCompany | null; issues: string[] } {
  const issues: string[] = [];
  const name = cleanText(rec.name);
  if (!name) return { incoming: null, issues: ["Missing company name."] };

  const website = normalizeUrl(rec.website);
  if (rec.website && cleanKnown(rec.website) && !website) issues.push(`Invalid website URL "${rec.website}".`);
  let domain = normalizeDomain(rec.domain) ?? normalizeDomain(website);
  if (rec.domain && cleanKnown(rec.domain) && !normalizeDomain(rec.domain)) issues.push(`Invalid domain "${rec.domain}".`);
  if (!domain) issues.push("No usable domain: matching will rely on ID or name.");

  const countryRaw = cleanKnown(rec.country);
  const countryInfo = lookupCountry(countryRaw);
  if (countryRaw && !countryInfo) issues.push(`Unrecognised country "${countryRaw}" (kept as text; location unresolved).`);
  const city = normalizeCity(rec.city);

  const fitScore = parseIntSafe(rec.fitScore);
  if (rec.fitScore && cleanKnown(rec.fitScore) && fitScore == null) issues.push(`Fit score "${rec.fitScore}" is not a number.`);

  let lat = num(rec.lat);
  let lng = num(rec.lng);
  if ((lat != null || lng != null) && (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
    issues.push("Invalid coordinates ignored.");
    lat = lng = null;
  }

  let email: IncomingCompany["email"] = null;
  if (cleanKnown(rec.contactEmail)) {
    const addr = normalizeEmail(rec.contactEmail);
    if (addr) email = { address: addr, contactName: cleanKnown(rec.contactName), contactTitle: cleanKnown(rec.contactTitle) };
    else issues.push(`Invalid email "${rec.contactEmail}" ignored.`);
  }

  const fields: IncomingCompany["fields"] = {
    name,
    originalName: cleanKnown(rec.originalName),
    website,
    domain,
    description: cleanKnown(rec.description),
    sizeText: cleanKnown(rec.sizeText),
    fitScore,
    matchTier: cleanKnown(rec.matchTier),
    industryPrimary: cleanKnown(rec.industryPrimary),
    industrySecondary: cleanKnown(rec.industrySecondary),
    regionGroup: cleanKnown(rec.regionGroup),
    country: countryInfo?.name ?? countryRaw,
    countryCode: countryInfo?.code ?? null,
    city,
    engineeringLocation: cleanKnown(rec.engineeringLocation),
    engineeringActivity: cleanKnown(rec.engineeringActivity),
    potentialInternWork: cleanKnown(rec.potentialInternWork),
    internshipEvidence: cleanKnown(rec.internshipEvidence),
    careersUrl: normalizeUrl(rec.careersUrl),
    opportunityUrl: normalizeUrl(rec.opportunityUrl),
    eligibilityStatus: cleanKnown(rec.eligibilityStatus),
    eligibilityNotes: cleanKnown(rec.eligibilityNotes),
    foundedText: cleanKnown(rec.foundedText),
    notes: cleanKnown(rec.notes),
    researchNotes: cleanKnown(rec.researchNotes),
    importedOutreachStatus: cleanKnown(rec.importedOutreachStatus),
    priority,
  };
  // Drop nulls so "absent" is distinguishable from "set".
  for (const k of Object.keys(fields) as ScalarField[]) if (fields[k] == null) delete fields[k];
  if (domain === null) delete fields.domain;

  const tags = [...new Set([...splitList(rec.tags), fields.industryPrimary, fields.industrySecondary].filter(Boolean) as string[])];
  return {
    incoming: {
      externalId: cleanText(rec.externalId),
      fields,
      tags,
      lat,
      lng,
      asOf: cleanKnown(rec.sourceAsOf),
      email,
      sourceRow,
    },
    issues,
  };
}

/** Decide field-level changes/conflicts when an incoming record targets an existing company. */
export function diffFields(
  existing: ExistingCompany,
  incoming: IncomingCompany,
  ctx: { importedSheets?: Set<string> } = {},
): { changes: FieldChange[]; conflicts: FieldConflict[] } {
  const changes: FieldChange[] = [];
  const conflicts: FieldConflict[] = [];
  for (const f of SCALAR_FIELDS) {
    const inc = incoming.fields[f];
    if (inc === undefined || inc === null || inc === "") continue; // never erase
    const cur = existing.fields[f] ?? null;
    if (f === "priority") {
      const prov = existing.provenance[f] as { source: string; sheet?: string } | undefined;
      if (cur === inc) continue;
      if (prov?.source === "manual") {
        conflicts.push({ field: f, existing: cur, incoming: inc, reason: "manual_edit" });
        continue;
      }
      const downgrade = PRIORITY_RANK[inc as Priority] < PRIORITY_RANK[(cur as Priority) ?? "other"];
      // A lower-priority sheet may only downgrade when the sheet that set the
      // current priority is part of this import and no longer lists the company.
      if (downgrade && !(prov?.sheet && ctx.importedSheets?.has(prov.sheet))) continue;
      changes.push({ field: f, from: cur, to: inc });
      continue;
    }
    if (cur === inc || String(cur ?? "") === String(inc)) continue;
    const prov = existing.provenance[f];
    if (prov?.source === "manual" || prov?.source === "apollo") {
      conflicts.push({ field: f, existing: cur, incoming: inc, reason: "manual_edit" });
      continue;
    }
    if (prov?.asOf && incoming.asOf && prov.asOf > incoming.asOf) {
      conflicts.push({ field: f, existing: cur, incoming: inc, reason: "newer_existing" });
      continue;
    }
    changes.push({ field: f, from: cur, to: inc });
  }
  return { changes, conflicts };
}

export interface PlanInput {
  sheets: { config: SheetConfig; rows: (string | null)[][] }[];
  existing: ExistingCompany[];
}

export function planImport(input: PlanInput): ImportPlan {
  const byExt = new Map<string, ExistingCompany>();
  const byDomain = new Map<string, ExistingCompany[]>();
  const byName = new Map<string, ExistingCompany[]>();
  for (const c of input.existing) {
    for (const e of c.externalIds) byExt.set(e, c);
    if (c.domain) byDomain.set(c.domain, [...(byDomain.get(c.domain) ?? []), c]);
    const nk = nameKey(c.name);
    if (nk) byName.set(nk, [...(byName.get(nk) ?? []), c]);
  }

  // In-batch index of rows that will create or update a company.
  interface BatchEntry { key: string; name: string; priority: Priority; targetId?: string }
  const batchByExt = new Map<string, BatchEntry>();
  const batchByDomain = new Map<string, BatchEntry[]>();
  const touchedExisting = new Map<string, BatchEntry>();

  const rows: PlanRow[] = [];
  const sheetsMeta: ImportPlan["sheets"] = [];
  const importedSheets = new Set(input.sheets.filter((s) => s.config.role === "companies").map((s) => s.config.sheet));

  // Company sheets in priority order so primary rows win in-batch merges; evidence last.
  const ordered = [...input.sheets].sort((a, b) => {
    const ra = a.config.role === "companies" ? PRIORITY_RANK[a.config.priority] : 0;
    const rb = b.config.role === "companies" ? PRIORITY_RANK[b.config.priority] : 0;
    return rb - ra;
  });

  for (const { config, rows: grid } of ordered) {
    if (config.role === "ignore") continue;
    const headers = grid[config.headerRow] ?? [];
    const dataRows = grid.slice(config.headerRow + 1);
    sheetsMeta.push({ sheet: config.sheet, role: config.role, priority: config.priority, dataRows: dataRows.filter((r) => r.some((c) => c != null)).length });

    dataRows.forEach((row, i) => {
      if (!row.some((c) => c != null)) return;
      const rowNumber = config.headerRow + 2 + i;
      const key = `${config.sheet}#${rowNumber}`;
      const raw = rowToObject(headers, row);
      const rec = extractRecord(row, config.mapping);

      if (config.role === "evidence") {
        const ev: EvidenceRecord = {
          evidenceId: cleanText(rec.evidenceId),
          companyExternalId: cleanText(rec.companyExternalId),
          fieldSupported: cleanKnown(rec.fieldSupported),
          url: normalizeUrl(rec.url),
          publisher: cleanKnown(rec.publisher),
          publishedDate: cleanKnown(rec.publishedDate),
          accessedDate: cleanKnown(rec.accessedDate),
          summary: cleanText(rec.summary),
        };
        const known = ev.companyExternalId && (byExt.has(ev.companyExternalId) || batchByExt.has(ev.companyExternalId));
        rows.push({ key, sheet: config.sheet, rowNumber, priority: config.priority, action: known ? "evidence" : "evidence_unmatched", evidence: ev, changes: [], conflicts: [], issues: known ? [] : [`No company with ID "${ev.companyExternalId ?? ""}".`], raw });
        return;
      }
      if (config.role !== "companies") return;

      const { incoming, issues } = normalizeCompanyRecord(rec, config.priority, raw);
      if (!incoming) {
        rows.push({ key, sheet: config.sheet, rowNumber, priority: config.priority, action: "invalid", changes: [], conflicts: [], issues, raw });
        return;
      }
      const base: PlanRow = { key, sheet: config.sheet, rowNumber, priority: config.priority, action: "add", incoming, changes: [], conflicts: [], issues, raw };
      const domain = (incoming.fields.domain as string | undefined) ?? null;
      const name = incoming.fields.name as string;

      // ── In-batch strong match (same ID, or same domain + similar name) ──
      const inBatch =
        (incoming.externalId && batchByExt.get(incoming.externalId)) ||
        (domain && (batchByDomain.get(domain) ?? []).find((e) => namesSimilar(e.name, name)));
      if (inBatch) {
        rows.push({ ...base, action: "merge_in_batch", mergeIntoKey: inBatch.key, targetCompanyId: inBatch.targetId, issues: [...issues, `Same company as ${inBatch.key}; adds alias ID and fills empty fields only.`] });
        if (incoming.externalId) batchByExt.set(incoming.externalId, inBatch);
        return;
      }

      // ── Match against existing records ──
      let target: ExistingCompany | undefined;
      let dupReason: string | undefined;
      let dupCompany: ExistingCompany | undefined;
      if (incoming.externalId && byExt.has(incoming.externalId)) target = byExt.get(incoming.externalId);
      else if (domain && byDomain.has(domain)) {
        const cands = byDomain.get(domain)!;
        const similar = cands.filter((c) => namesSimilar(c.name, name));
        if (cands.length === 1 && similar.length === 1) target = similar[0];
        else {
          dupCompany = similar[0] ?? cands[0];
          dupReason = cands.length > 1 ? `Domain ${domain} is shared by ${cands.length} companies (parent/subsidiary?).` : `Same domain ${domain} but a different name ("${cands[0].name}").`;
        }
      } else {
        const nk = nameKey(name);
        const cands = nk ? byName.get(nk) ?? [] : [];
        if (cands.length) {
          dupCompany = cands[0];
          dupReason = `Name matches "${cands[0].name}" but domain/ID differ or are missing.`;
        }
      }

      if (target) {
        // Another higher-priority row in this import already updated it → merge.
        const prior = touchedExisting.get(target.id);
        if (prior) {
          rows.push({ ...base, action: "merge_in_batch", mergeIntoKey: prior.key, targetCompanyId: target.id, issues: [...issues, `Same company as ${prior.key}.`] });
          if (incoming.externalId) batchByExt.set(incoming.externalId, prior);
          return;
        }
        const { changes, conflicts } = diffFields(target, incoming, { importedSheets });
        const newAlias = incoming.externalId && !target.externalIds.includes(incoming.externalId);
        const action: PlanAction = changes.length || conflicts.length || newAlias ? "update" : "unchanged";
        const entry: BatchEntry = { key, name, priority: config.priority, targetId: target.id };
        touchedExisting.set(target.id, entry);
        if (incoming.externalId) batchByExt.set(incoming.externalId, entry);
        if (domain) batchByDomain.set(domain, [...(batchByDomain.get(domain) ?? []), entry]);
        rows.push({ ...base, action, targetCompanyId: target.id, changes, conflicts });
        return;
      }
      if (dupCompany) {
        rows.push({ ...base, action: "duplicate_review", duplicate: { companyId: dupCompany.id, companyName: dupCompany.name, reason: dupReason! } });
        return;
      }
      const entry: BatchEntry = { key, name, priority: config.priority };
      if (incoming.externalId) batchByExt.set(incoming.externalId, entry);
      if (domain) batchByDomain.set(domain, [...(batchByDomain.get(domain) ?? []), entry]);
      rows.push(base);
    });
  }

  const counts = {
    add: 0, update: 0, unchanged: 0, merge_in_batch: 0, duplicate_review: 0, invalid: 0, evidence: 0, evidence_unmatched: 0,
    distinctCompaniesAfter: 0, byPriority: {} as Record<string, number>,
  };
  for (const r of rows) counts[r.action]++;
  // Distinct companies this import touches or creates (not counting duplicates pending review).
  const distinct = rows.filter((r) => r.action === "add" || r.action === "update" || r.action === "unchanged");
  counts.distinctCompaniesAfter = input.existing.length + rows.filter((r) => r.action === "add").length;
  for (const r of distinct) counts.byPriority[r.priority] = (counts.byPriority[r.priority] ?? 0) + 1;
  return { rows, counts, sheets: sheetsMeta };
}
