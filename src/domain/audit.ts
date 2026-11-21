import type { DbOrTx } from "@/db/client";
import * as s from "@/db/schema";

export async function audit(
  db: DbOrTx,
  e: { ownerId: string; entityType: string; entityId: string; action: string; before?: unknown; after?: unknown; actor?: string },
) {
  await db.insert(s.auditEvents).values({
    ownerId: e.ownerId,
    entityType: e.entityType,
    entityId: e.entityId,
    action: e.action,
    before: (e.before ?? null) as object,
    after: (e.after ?? null) as object,
    actor: e.actor ?? "user",
  });
}
