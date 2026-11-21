import { desc, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";

/** Liveness for hosting platforms. Reveals no private data. */
export async function GET() {
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    const [beat] = await db.select().from(s.workerHeartbeats).orderBy(desc(s.workerHeartbeats.lastBeatAt)).limit(1);
    const age = beat ? Math.round((Date.now() - beat.lastBeatAt.getTime()) / 1000) : null;
    return Response.json({ ok: true, db: "up", workerHeartbeatAgeSeconds: age });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
