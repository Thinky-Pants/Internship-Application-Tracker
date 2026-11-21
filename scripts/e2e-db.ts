/**
 * Isolated database for browser tests: in-memory PGlite, migrated, with a test
 * owner and demo data, served on E2E_DB_PORT. The port opens only after seeding,
 * so Playwright starts the app once the data is ready. Nothing is persisted and
 * only mock providers are used.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as s from "../src/db/schema";
import type { Db } from "../src/db/client";
import { hashPassword } from "../src/lib/crypto";
import { LocalStorage } from "../src/lib/storage";
import { FileMockStore } from "../src/providers/mail/mock";
import { seedDemo } from "../src/domain/demo/seed";
import { E2E_OWNER } from "../e2e/credentials";

const port = Number(process.env.E2E_DB_PORT ?? 54330);
const client = await PGlite.create();
const db = drizzle(client, { schema: s }) as unknown as Db;
await migrate(drizzle(client), { migrationsFolder: "drizzle" });
const [owner] = await db.insert(s.owners).values({ email: E2E_OWNER.email, displayName: "E2E Owner", passwordHash: hashPassword(E2E_OWNER.password) }).returning();
await db.insert(s.settings).values({ ownerId: owner.id });
await seedDemo(db, new LocalStorage(process.env.STORAGE_DIR ?? "./data/e2e-files"), new FileMockStore(), owner.id);
// Allow sending at any time so tests don't depend on the weekday or hour they run.
await db.update(s.settings).set({ sendingWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "23:59" } }).where(eq(s.settings.ownerId, owner.id));
const server = new PGLiteSocketServer({ db: client, port, host: "127.0.0.1", maxConnections: 20 } as ConstructorParameters<typeof PGLiteSocketServer>[0]);
await server.start();
console.log(`E2E database ready on ${port}`);
const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
