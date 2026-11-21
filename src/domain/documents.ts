/**
 * Versioned CV library. Each upload is an immutable document_version with its
 * exact bytes (sha256) in private storage. Messages reference a specific
 * version, so replacing a CV never changes what historical messages carried.
 * Integration boundary for the separate CV app: documents.external_source /
 * external_ref + uploadCvVersion() — see docs/ARCHITECTURE.md.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { sha256Hex } from "@/lib/crypto";
import type { Services } from "./services";

export const MAX_CV_BYTES = 10 * 1024 * 1024;

export class DocumentError extends Error {}

export function assertPdf(bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new DocumentError("The file is empty.");
  if (bytes.byteLength > MAX_CV_BYTES) throw new DocumentError("PDF exceeds 10 MB.");
  const head = Buffer.from(bytes.slice(0, 5)).toString("latin1");
  if (head !== "%PDF-") throw new DocumentError("Only PDF files are accepted for CVs.");
}

export function safeFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "cv.pdf";
  const clean = base.replace(/[^\w.\- ()]+/g, "_").slice(0, 120);
  return clean.toLowerCase().endsWith(".pdf") ? clean : clean + ".pdf";
}

export async function uploadCvVersion(
  svc: Services,
  args: { ownerId: string; documentId?: string; title?: string; description?: string; industryTags?: string[]; filename: string; bytes: Uint8Array; note?: string; isDemo?: boolean },
) {
  assertPdf(args.bytes);
  const sha = sha256Hex(args.bytes);
  return svc.db.transaction(async (tx) => {
    let docId = args.documentId;
    if (docId) {
      const [d] = await tx.select().from(s.documents).where(and(eq(s.documents.id, docId), eq(s.documents.ownerId, args.ownerId)));
      if (!d) throw new DocumentError("Document not found.");
    } else {
      const [d] = await tx.insert(s.documents).values({ ownerId: args.ownerId, kind: "cv", title: args.title ?? args.filename, description: args.description, industryTags: args.industryTags ?? [], isDemo: args.isDemo ?? false }).returning();
      docId = d.id;
    }
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${s.documentVersions.versionNo}), 0) + 1` }).from(s.documentVersions).where(eq(s.documentVersions.documentId, docId));
    const filename = safeFilename(args.filename);
    const storageKey = `cv/${docId}/v${next}-${sha.slice(0, 16)}.pdf`;
    await svc.storage.put(storageKey, args.bytes, "application/pdf");
    const [v] = await tx.insert(s.documentVersions).values({ documentId: docId, versionNo: next, filename, mimeType: "application/pdf", sizeBytes: args.bytes.byteLength, sha256: sha, storageKey, note: args.note, uploadedAt: svc.clock.now() }).returning();
    await tx.update(s.documents).set({ currentVersionId: v.id, ...(args.description ? { description: args.description } : {}), ...(args.industryTags ? { industryTags: args.industryTags } : {}) }).where(eq(s.documents.id, docId));
    return v;
  });
}

/** Read a version's bytes and verify integrity against the recorded hash. */
export async function readVersionBytes(svc: Services, versionId: string) {
  const [v] = await svc.db.select().from(s.documentVersions).where(eq(s.documentVersions.id, versionId));
  if (!v) throw new DocumentError("Document version not found.");
  const bytes = await svc.storage.get(v.storageKey);
  if (sha256Hex(bytes) !== v.sha256) throw new DocumentError(`Stored bytes for ${v.filename} v${v.versionNo} do not match the recorded hash.`);
  return { version: v, bytes };
}

export async function listCvs(svc: Services, ownerId: string) {
  const docs = await svc.db.select().from(s.documents).where(and(eq(s.documents.ownerId, ownerId), eq(s.documents.archived, false)));
  const versions = await svc.db.select().from(s.documentVersions).orderBy(desc(s.documentVersions.versionNo));
  return docs.map((d) => ({ ...d, versions: versions.filter((v) => v.documentId === d.id) }));
}
