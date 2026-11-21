import "../src/worker/env";
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "../src/db/client";
import { getStorage } from "../src/lib/storage";
import { createBackup } from "../src/domain/backup";

const out = process.argv[2] ?? path.join("backups", `outreach-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await createBackup(getDb(), getStorage()));
console.log(`Backup written to ${out}`);
await closeDb();
