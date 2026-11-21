/** In-process PGlite database for tests and single-process scripts. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import { MIGRATIONS_DIR, type Db } from "./client";

export async function createPgliteDb(dataDir?: string): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db: db as unknown as Db, client };
}
