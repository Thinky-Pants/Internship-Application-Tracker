/**
 * Acceptance scenarios 1–3: multi-sheet workbook with inconsistent headers,
 * correct counts, safe reimport, ambiguous duplicates kept for review.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import fs from "node:fs";
import * as s from "@/db/schema";
import { writeWorkbook } from "@/domain/import/xlsx-write";
import { parseUpload } from "@/domain/import/parse";
import { suggestMapping, suggestSheetRole, type SheetConfig } from "@/domain/import/mapping";
import { planImport } from "@/domain/import/planner";
import { commitImport, loadExistingSnapshot, rollbackImport, analyzeRollback } from "@/domain/import/commit";
import { freshDb } from "./helpers";
import type { Db } from "@/db/client";

function workbook(extraPrimaryRows: (string | null)[][] = []) {
  return writeWorkbook([
    { name: "Summary", rows: [["Dimension", "Total"], ["All", "5"]] },
    {
      name: "Companies",
      rows: [
        ["company id", "COMPANY NAME", "Website URL", "hq country", "HQ city", "Primary Industry", "Outreach Status", "Notes"],
        ["C-1", "Alpha Robotics", "https://www.alpha-robotics.com/careers", "USA", "San Francisco, CA", "Robotics", "Not contacted", "Small team"],
        ["C-2", "Beta Aero GmbH", "beta-aero.de", "deutschland", "Munich", "Aerospace", "Emailed in 2025", null],
        ["C-3", "Gamma Energy", "https://gamma.energy", "u.k.", "Leeds", "Energy", null, null],
        [null, null, null, null, null, null, null, null],
        ["C-4", null, "https://nameless.example", "France", null, null, null, null],
        ...extraPrimaryRows,
      ],
    },
    {
      name: "Reserves",
      rows: [
        ["Company_ID", "Company_Name", "Canonical_Domain", "HQ_Country_or_Territory", "Primary_Industry"],
        ["R-1", "Delta Thermal", "delta-thermal.se", "Sweden", "HVAC"],
      ],
    },
    {
      name: "Leads",
      rows: [
        ["Lead_ID", "Company_Name", "Website_URL", "HQ_Country_or_Territory", "Sector_Tags", "Size_if_Listed"],
        ["L-1", "Alpha Robotics Inc.", "http://alpha-robotics.com", "United States", "Robotics; Automation", "12"],
        ["L-2", "Epsilon Motors", "epsilon-motors.com", "Japan", "Automotive", "40"],
        ["L-3", "Zeta Labs", "zetalabs.io", "Atlantis", "Other", null],
      ],
    },
    {
      name: "Sources",
      rows: [
        ["Source_ID", "Company_ID", "Field_Supported", "Source_URL", "Publisher", "Accessed_Date", "Evidence_Summary"],
        ["S-1", "C-1", "Engineering_Activity", "https://alpha-robotics.com", "Alpha", "2026-11-01", "Builds robot arms."],
        ["S-2", "C-99", "HQ_City", "https://x.example", "X", "2026-11-01", "Unknown company."],
      ],
    },
  ]);
}

function configsFor(bytes: Uint8Array) {
  const wb = parseUpload("test.xlsx", bytes);
  return wb.sheets.map((sh) => {
    const sug = suggestSheetRole(sh.name, sh.rows[0] ?? []);
    const config: SheetConfig = { sheet: sh.name, role: sug.role, priority: sug.priority, headerRow: 0, mapping: suggestMapping(sh.rows[0] ?? [], sug.role) };
    return { config, rows: sh.rows };
  });
}

async function runImport(db: Db, ownerId: string, bytes: Uint8Array, resolutions = {}) {
  const sheets = configsFor(bytes);
  const plan = planImport({ sheets, existing: await loadExistingSnapshot(db, ownerId) });
  const [batch] = await db.insert(s.importBatches).values({ ownerId, kind: "workbook", filename: "test.xlsx", fileSha256: "x" }).returning();
  const report = await commitImport(db, { ownerId, batchId: batch.id, plan, resolutions });
  return { plan, report, batchId: batch.id };
}

describe("workbook import", () => {
  let ctx: Awaited<ReturnType<typeof freshDb>>;
  beforeEach(async () => (ctx = await freshDb()));
  afterEach(async () => ctx.close());

  it("previews roles, mappings and computes counts from records", async () => {
    const sheets = configsFor(workbook());
    const roles = Object.fromEntries(sheets.map((x) => [x.config.sheet, `${x.config.role}/${x.config.priority}`]));
    expect(roles).toEqual({ Summary: "ignore/other", Companies: "companies/primary", Reserves: "companies/reserve", Leads: "companies/lead", Sources: "evidence/other" });
    const companies = sheets.find((x) => x.config.sheet === "Companies")!.config.mapping;
    expect(companies.name).toBe(1);
    expect(companies.website).toBe(2);
    expect(companies.importedOutreachStatus).toBe(6);

    const plan = planImport({ sheets, existing: [] });
    expect(plan.counts.add).toBe(6); // Alpha, Beta, Gamma, Delta, Epsilon, Zeta
    expect(plan.counts.merge_in_batch).toBe(1); // L-1 is Alpha
    expect(plan.counts.invalid).toBe(1); // nameless row
    expect(plan.counts.evidence).toBe(1);
    expect(plan.counts.evidence_unmatched).toBe(1);
    expect(plan.counts.byPriority).toEqual({ primary: 3, reserve: 1, lead: 2 });
    const zeta = plan.rows.find((r) => r.incoming?.fields.name === "Zeta Labs")!;
    expect(zeta.issues.join(" ")).toMatch(/Unrecognised country/);
    const beta = plan.rows.find((r) => r.incoming?.fields.name === "Beta Aero GmbH")!;
    expect(beta.incoming!.fields.country).toBe("Germany");
    expect(beta.incoming!.fields.domain).toBe("beta-aero.de");
  });

  it("commits, then reimports without duplicates or erasing later work", async () => {
    const { db, ownerId } = ctx;
    const first = await runImport(db, ownerId, workbook());
    expect(first.report.added).toBe(6);
    const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(s.companies).where(eq(s.companies.ownerId, ownerId)))[0].n;
    expect(await count()).toBe(6);

    // Imported "Emailed in 2025" is historical text only: no messages exist.
    const msgs = await db.select().from(s.messages);
    expect(msgs).toHaveLength(0);
    const [beta] = await db.select().from(s.companies).where(eq(s.companies.name, "Beta Aero GmbH"));
    expect(beta.importedOutreachStatus).toBe("Emailed in 2025");

    // Alpha merged with lead L-1: one company, both IDs, priority primary, tags merged.
    const [alpha] = await db.select().from(s.companies).where(eq(s.companies.domain, "alpha-robotics.com"));
    expect(alpha.priority).toBe("primary");
    const ids = await db.select().from(s.companyExternalIds).where(eq(s.companyExternalIds.companyId, alpha.id));
    expect(ids.map((i) => i.value).sort()).toEqual(["C-1", "L-1"]);
    expect(alpha.sizeText).toBe("12"); // filled from lead (was empty)

    // Later work: a manual note edit, a contact, and a user-edited priority.
    await db.update(s.companies).set({ notes: "Spoke at career fair", fieldProvenance: { ...(alpha.fieldProvenance as object), notes: { source: "manual", at: new Date().toISOString() } } }).where(eq(s.companies.id, alpha.id));
    await db.insert(s.contacts).values({ ownerId, companyId: alpha.id, fullName: "Ada Lovelace", source: "manual" });

    const second = await runImport(db, ownerId, workbook());
    expect(await count()).toBe(6);
    expect(second.report.added).toBe(0);
    const alphaRow = second.plan.rows.find((r) => r.key === "Companies#2")!;
    expect(alphaRow.conflicts.map((c) => c.field)).toContain("notes");
    const [alpha2] = await db.select().from(s.companies).where(eq(s.companies.id, alpha.id));
    expect(alpha2.notes).toBe("Spoke at career fair"); // manual note kept
    expect((await db.select().from(s.contacts).where(eq(s.contacts.companyId, alpha.id))).length).toBe(1);

    // Field-level conflict choice: take incoming.
    const third = await runImport(db, ownerId, workbook(), { "Companies#2:notes": "incoming" });
    expect(third.report.conflictsTakenIncoming).toBe(1);
    const [alpha3] = await db.select().from(s.companies).where(eq(s.companies.id, alpha.id));
    expect(alpha3.notes).toBe("Small team");

    // Evidence upserted, not duplicated.
    expect((await db.select().from(s.companyEvidence)).length).toBe(1);
  });

  it("never erases values with empty cells", async () => {
    const { db, ownerId } = ctx;
    await runImport(db, ownerId, workbook());
    const blanked = writeWorkbook([{ name: "Companies", rows: [["Company_ID", "Company_Name", "HQ_City", "Notes"], ["C-1", "Alpha Robotics", null, null]] }]);
    const r = await runImport(db, ownerId, blanked);
    expect(r.report.updated + r.report.unchanged).toBe(1);
    const [alpha] = await db.select().from(s.companies).where(eq(s.companies.externalId, "C-1"));
    expect(alpha.city).toBe("San Francisco");
    expect(alpha.notes).toBe("Small team");
  });

  it("keeps ambiguous duplicates for review instead of merging", async () => {
    const { db, ownerId } = ctx;
    await runImport(db, ownerId, workbook());
    const wb2 = writeWorkbook([
      {
        name: "Companies",
        rows: [
          ["Company_ID", "Company_Name", "Website_URL", "HQ_Country_or_Territory"],
          ["C-50", "Gamma Energy", "https://gamma-energy-uk.com", "United Kingdom"], // name-only match
          ["C-51", "Totally Different Ltd", "https://gamma.energy/sub", "United Kingdom"], // same domain, different name
        ],
      },
    ]);
    const r = await runImport(db, ownerId, wb2);
    expect(r.report.duplicatesForReview).toBe(2);
    expect(r.report.added).toBe(0);
    const dups = await db.select().from(s.duplicateCandidates).where(eq(s.duplicateCandidates.status, "open"));
    expect(dups).toHaveLength(2);
    expect((await db.select().from(s.companies)).length).toBe(6);
  });

  it("rolls back untouched records and keeps those with later dependencies", async () => {
    const { db, ownerId } = ctx;
    const { batchId } = await runImport(db, ownerId, workbook());
    const [epsilon] = await db.select().from(s.companies).where(eq(s.companies.name, "Epsilon Motors"));
    await db.insert(s.contacts).values({ ownerId, companyId: epsilon.id, fullName: "Ken Sato", source: "manual" });
    const analysis = await analyzeRollback(db, ownerId, batchId);
    expect(analysis.dependencies.map((d) => d.companyName)).toEqual(["Epsilon Motors"]);
    const res = await rollbackImport(db, ownerId, batchId);
    expect(res.removed).toBe(5);
    const left = await db.select().from(s.companies);
    expect(left.map((c) => c.name)).toEqual(["Epsilon Motors"]);
    const [batch] = await db.select().from(s.importBatches).where(and(eq(s.importBatches.id, batchId)));
    expect(batch.status).toBe("correction_needed");
  });

  const real = process.env.WORKBOOK_PATH;
  it.skipIf(!real || !fs.existsSync(real ?? ""))("imports the owner's real workbook (opt-in via WORKBOOK_PATH)", async () => {
    const { db, ownerId } = ctx;
    const bytes = new Uint8Array(fs.readFileSync(real!));
    const first = await runImport(db, ownerId, bytes);
    const total = (await db.select({ n: sql<number>`count(*)::int` }).from(s.companies))[0].n;
    expect(total).toBe(first.report.added);
    const again = await runImport(db, ownerId, bytes);
    expect(again.report.added).toBe(0);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(s.companies))[0].n).toBe(total);
  });
});
