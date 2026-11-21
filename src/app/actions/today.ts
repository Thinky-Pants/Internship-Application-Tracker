"use server";
import { eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getServices } from "@/server/runtime";
import { back } from "@/server/flash";
import * as s from "@/db/schema";

const KEYS = ["replies", "interviews", "sendIssues", "followups", "drafts", "tasks", "ready"];

export async function saveTodayOrderAction(fd: FormData) {
  const o = await requireOwner();
  const order = [...KEYS].sort((a, b) => Number(fd.get(a) ?? 9) - Number(fd.get(b) ?? 9));
  await getServices().db.update(s.settings).set({ todayPriorities: { order } }).where(eq(s.settings.ownerId, o.id));
  back("/", { msg: "Today priorities saved." });
}
