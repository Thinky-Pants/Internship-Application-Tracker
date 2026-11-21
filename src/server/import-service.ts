import "server-only";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { sha256Hex } from "@/lib/crypto";
import { getServices } from "./runtime";
import { parseUpload } from "@/domain/import/parse";
import { headerSignature, suggestMapping, suggestSheetRole, type SheetConfig } from "@/domain/import/mapping";
import { planImport } from "@/domain/import/planner";
import { loadExistingSnapshot } from "@/domain/import/commit";
import type { WorkbookGrid } from "@/domain/import/xlsx";

export async function createBatch(ownerId: string, filename: string, bytes: Uint8Array, kind: "workbook" | "apollo_csv") {
  const svc = getServices();
  const grid = parseUpload(filename, bytes); // validates type/size/structure
  const [batch] = await svc.db.insert(s.importBatches).values({ ownerId, kind, filename: filename.slice(0, 200), fileSha256: sha256Hex(bytes) }).returning();
  const ext = filename.toLowerCase().endsWith(".csv") ? "csv" : "xlsx";
  const key = `imports/${batch.id}.${ext}`;
  await svc.storage.put(key, bytes, ext === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const config = await defaultConfig(ownerId, grid, kind);
  await svc.db.update(s.importBatches).set({ storageKey: key, sheetConfig: config }).where(eq(s.importBatches.id, batch.id));
  return batch.id;
}

export async function defaultConfig(ownerId: string, grid: WorkbookGrid, kind: "workbook" | "apollo_csv"): Promise<(SheetConfig & { reason: string; signature: string })[]> {
  const db = getServices().db;
  const saved = await db.select().from(s.columnMappings).where(eq(s.columnMappings.ownerId, ownerId));
  return grid.sheets.map((sh) => {
    const headers = sh.rows[0] ?? [];
    const sig = headerSignature(headers);
    const sug = kind === "apollo_csv" ? { role: "apollo_contacts" as const, priority: "other" as const, reason: "Apollo contact CSV." } : suggestSheetRole(sh.name, headers);
    const reuse = saved.find((m) => m.headerSignature === sig && m.kind === sug.role);
    return { sheet: sh.name, role: sug.role, priority: sug.priority, headerRow: 0, mapping: (reuse?.mapping as SheetConfig["mapping"]) ?? suggestMapping(headers, sug.role), reason: reuse ? `${sug.reason} Reusing saved mapping "${reuse.name}".` : sug.reason, signature: sig };
  });
}

export async function loadBatch(ownerId: string, batchId: string) {
  const svc = getServices();
  const [batch] = await svc.db.select().from(s.importBatches).where(and(eq(s.importBatches.id, batchId), eq(s.importBatches.ownerId, ownerId)));
  if (!batch) return null;
  const bytes = await svc.storage.get(batch.storageKey!);
  const grid = parseUpload(batch.filename, bytes);
  return { batch, grid, config: batch.sheetConfig as (SheetConfig & { reason?: string; signature?: string })[] };
}

export async function planBatch(ownerId: string, grid: WorkbookGrid, config: SheetConfig[]) {
  const db = getServices().db;
  const sheets = config.map((c) => ({ config: c, rows: grid.sheets.find((g) => g.name === c.sheet)?.rows ?? [] }));
  return planImport({ sheets, existing: await loadExistingSnapshot(db, ownerId) });
}

export async function rememberMappings(ownerId: string, config: (SheetConfig & { signature?: string })[]) {
  const db = getServices().db;
  for (const c of config) {
    if (c.role === "ignore" || !c.signature) continue;
    await db.insert(s.columnMappings).values({ ownerId, name: c.sheet, kind: c.role, headerSignature: c.signature, mapping: c.mapping })
      .onConflictDoUpdate({ target: [s.columnMappings.ownerId, s.columnMappings.kind, s.columnMappings.headerSignature], set: { mapping: c.mapping } });
  }
}
