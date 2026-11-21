import { getServices } from "@/server/runtime";
import { apiOwner, download, handler } from "@/server/http";
import { createBackup } from "@/domain/backup";

export const GET = handler(async () => {
  await apiOwner();
  const svc = getServices();
  const zip = await createBackup(svc.db, svc.storage);
  return download(Buffer.from(zip), `outreach-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`, "application/zip");
});
