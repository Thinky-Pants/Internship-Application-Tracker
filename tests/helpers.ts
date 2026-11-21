import { createPgliteDb } from "@/db/pglite";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { hashPassword } from "@/lib/crypto";

export async function freshDb(): Promise<{ db: Db; ownerId: string; close: () => Promise<void> }> {
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const { db, client } = await createPgliteDb();
  const [owner] = await db.insert(s.owners).values({ email: "owner@example.test", displayName: "Test Owner", passwordHash: hashPassword("test-pass-123") }).returning();
  await db.insert(s.settings).values({ ownerId: owner.id });
  return { db, ownerId: owner.id, close: () => client.close() };
}
