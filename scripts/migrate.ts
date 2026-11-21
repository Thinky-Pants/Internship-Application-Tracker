import "../src/worker/env";
import { getDb, migrateDb, closeDb } from "../src/db/client";

const db = getDb();
await migrateDb(db);
console.log("Migrations applied.");
await closeDb();
