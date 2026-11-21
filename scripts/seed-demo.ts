/**
 * Seed (or reset) isolated demo data. Never contacts real providers.
 *   npm run seed:demo            → reset + seed demo records
 *   npm run seed:demo -- --reset → remove demo records only
 * If no owner exists yet, a demo owner is created using DEMO_OWNER_EMAIL /
 * DEMO_PASSWORD from your .env (see .env.example).
 */
import "../src/worker/env";
import { sql } from "drizzle-orm";
import { getDb, migrateDb, closeDb } from "../src/db/client";
import * as s from "../src/db/schema";
import { getStorage } from "../src/lib/storage";
import { hashPassword } from "../src/lib/crypto";
import { FileMockStore } from "../src/providers/mail/mock";
import { seedDemo, resetDemo } from "../src/domain/demo/seed";

const db = getDb();
await migrateDb(db);
if (process.argv.includes("--reset")) {
  await resetDemo(db);
  console.log("Demo records removed.");
} else {
  let [owner] = await db.select().from(s.owners).limit(1);
  if (!owner) {
    const email = process.env.DEMO_OWNER_EMAIL ?? "demo-owner@example.test";
    const pass = process.env.DEMO_PASSWORD;
    if (!pass || pass.length < 12) throw new Error("Set DEMO_PASSWORD (12+ chars) in .env to create the demo owner.");
    [owner] = await db.insert(s.owners).values({ email, displayName: "Demo Owner", passwordHash: hashPassword(pass) }).returning();
    await db.insert(s.settings).values({ ownerId: owner.id }).onConflictDoNothing();
    console.log(`Created demo owner ${email} (passphrase from DEMO_PASSWORD).`);
  }
  const r = await seedDemo(db, getStorage(), new FileMockStore(), owner.id);
  const res = (await db.execute(sql`select count(*)::int as n from messages where is_demo`)) as unknown as { rows: { n: number }[] };
  const n = res.rows[0]?.n ?? 0;
  console.log(`Demo seeded: ${r.companies} companies, ${n} messages (mock mailbox only).`);
}
await closeDb();
