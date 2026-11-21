import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { getDb } from "@/db/client";
import { apiOwner, download, handler } from "@/server/http";
import { toCsv } from "@/domain/import/xlsx-write";

export const GET = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const owner = await apiOwner();
  const { id } = await ctx.params;
  const db = getDb();
  const [b] = await db.select().from(s.importBatches).where(and(eq(s.importBatches.id, id), eq(s.importBatches.ownerId, owner.id)));
  if (!b) return new Response("Not found", { status: 404 });
  const rows = await db.select().from(s.importRows).where(eq(s.importRows.batchId, id));
  const withIssues = rows.filter((r) => (r.issues as string[]).length);
  return download(toCsv([["sheet", "row", "action", "issues", "original_row_json"], ...withIssues.map((r) => [r.sheet, r.rowNumber, r.action, (r.issues as string[]).join(" | "), JSON.stringify(r.raw)])]), `import-issues-${id.slice(0, 8)}.csv`, "text/csv; charset=utf-8");
});
