import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { getServices } from "@/server/runtime";
import { apiOwner, download, handler } from "@/server/http";
import { readVersionBytes } from "@/domain/documents";

/** Private CV download/preview. Requires the owner session; never cached. */
export const GET = handler(async (req: Request, ctx: { params: Promise<{ versionId: string }> }) => {
  const owner = await apiOwner();
  const { versionId } = await ctx.params;
  const svc = getServices();
  const [row] = await svc.db.select({ v: s.documentVersions, d: s.documents }).from(s.documentVersions).innerJoin(s.documents, eq(s.documents.id, s.documentVersions.documentId)).where(eq(s.documentVersions.id, versionId));
  if (!row || row.d.ownerId !== owner.id) return new Response("Not found", { status: 404 });
  const { bytes } = await readVersionBytes(svc, versionId);
  const res = download(Buffer.from(bytes), row.v.filename, "application/pdf");
  if (new URL(req.url).searchParams.get("inline") === "1") res.headers.set("Content-Disposition", `inline; filename="${row.v.filename}"`);
  return res;
});
