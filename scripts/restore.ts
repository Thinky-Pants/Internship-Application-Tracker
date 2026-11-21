import "../src/worker/env";
import fs from "node:fs";
import { getDb, migrateDb, closeDb } from "../src/db/client";
import { getStorage } from "../src/lib/storage";
import { restoreBackup } from "../src/domain/backup";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run restore -- path/to/backup.zip   (target database must be empty)");
  process.exit(1);
}
const db = getDb();
await migrateDb(db);
const r = await restoreBackup(db, getStorage(), new Uint8Array(fs.readFileSync(file)));
console.log(`Restored ${r.tables} tables and ${r.files} files. Use the same APP_ENCRYPTION_KEY so stored credentials can be decrypted.`);
await closeDb();
