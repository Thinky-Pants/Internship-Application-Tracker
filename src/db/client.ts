import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import path from "node:path";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Works for both node-postgres and PGlite drivers. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle");

const globalForDb = globalThis as unknown as { __iomDb?: Db; __iomPool?: pg.Pool };

/** Shared process-wide database handle (web and worker each create their own pool). */
export function getDb(): Db {
  if (globalForDb.__iomDb) return globalForDb.__iomDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
  });
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  globalForDb.__iomPool = pool;
  globalForDb.__iomDb = drizzlePg(pool, { schema }) as unknown as Db;
  return globalForDb.__iomDb;
}

export async function migrateDb(db: Db) {
  await migratePg(db as unknown as NodePgDatabase<Schema>, { migrationsFolder: MIGRATIONS_DIR });
}

export async function closeDb() {
  await globalForDb.__iomPool?.end();
  globalForDb.__iomPool = undefined;
  globalForDb.__iomDb = undefined;
}

/** For tests/scripts: inject a database (e.g. in-process PGlite). */
export function setDb(db: Db) {
  globalForDb.__iomDb = db;
}

export { schema };
