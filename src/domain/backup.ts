/**
 * Portable backup: one JSON file per table + every stored file, in a zip.
 * Single-owner app → the whole database is the owner's data. Sessions,
 * heartbeats and webhook receipts are excluded (ephemeral). Encrypted
 * credentials stay encrypted (restore needs the same APP_ENCRYPTION_KEY).
 * Restore targets an EMPTY, migrated database and inserts in FK order.
 */
import { sql } from "drizzle-orm";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import type { Db } from "@/db/client";
import type { Storage } from "@/lib/storage";

export const BACKUP_TABLES = [
  "owners", "settings", "companies", "company_external_ids", "company_locations", "company_tags", "company_evidence", "contacts", "email_addresses",
  "discovery_jobs", "discovery_attempts", "opportunities", "campaigns", "sequences", "enrollments", "mailboxes", "mailbox_folders", "mailbox_subscriptions",
  "conversations", "documents", "document_versions", "templates", "messages", "message_revisions", "approvals", "scheduled_sends", "dispatch_attempts",
  "queue_events", "jobs", "candidate_profile", "tasks", "import_batches", "import_rows", "column_mappings", "duplicate_candidates", "export_batches",
  "saved_views", "ai_jobs", "ai_exchange_packages", "ai_exchange_results", "suppressions", "audit_events", "provider_credentials", "usage_ledger", "geocode_cache",
];

async function rows(db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const r = (await db.execute(q)) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  return Array.isArray(r) ? r : r.rows ?? [];
}

export async function createBackup(db: Db, storage: Storage): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const manifest: Record<string, unknown> = { format: "iom-backup/v1", createdAt: new Date().toISOString(), tables: {} as Record<string, number> };
  for (const t of BACKUP_TABLES) {
    const [r] = await rows(db, sql.raw(`SELECT coalesce(json_agg(t), '[]'::json)::text AS data, count(*)::int AS n FROM "${t}" t`));
    files[`data/${t}.json`] = strToU8(String(r.data));
    (manifest.tables as Record<string, number>)[t] = Number(r.n);
  }
  const keys = [...(await storage.list("cv")), ...(await storage.list("imports"))];
  for (const k of keys) files[`files/${k}`] = await storage.get(k);
  manifest.files = keys.length;
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

export async function restoreBackup(db: Db, storage: Storage, zip: Uint8Array) {
  const files = unzipSync(zip);
  const manifest = JSON.parse(strFromU8(files["manifest.json"])) as { format: string };
  if (manifest.format !== "iom-backup/v1") throw new Error("Not an Outreach Manager backup.");
  const [{ n }] = await rows(db, sql`SELECT count(*)::int AS n FROM owners`);
  if (Number(n) > 0) throw new Error("Restore requires an empty database (owners table is not empty).");
  await db.transaction(async (tx) => {
    // Append-only triggers must not block inserts; they only reject UPDATE.
    for (const t of BACKUP_TABLES) {
      const f = files[`data/${t}.json`];
      if (!f) continue;
      const json = strFromU8(f);
      if (json === "[]") continue;
      const identity = ["queue_events", "audit_events"].includes(t) ? "OVERRIDING SYSTEM VALUE" : "";
      await tx.execute(sql`INSERT INTO ${sql.raw(`"${t}"`)} ${sql.raw(identity)} SELECT * FROM json_populate_recordset(null::${sql.raw(`"${t}"`)}, ${json}::json)`);
    }
    await tx.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('queue_events','id'), coalesce((SELECT max(id) FROM queue_events), 1))`));
    await tx.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('audit_events','id'), coalesce((SELECT max(id) FROM audit_events), 1))`));
  });
  let restoredFiles = 0;
  for (const [k, v] of Object.entries(files)) {
    if (!k.startsWith("files/")) continue;
    await storage.put(k.slice(6), v, "application/octet-stream");
    restoredFiles++;
  }
  return { tables: BACKUP_TABLES.length, files: restoredFiles };
}
