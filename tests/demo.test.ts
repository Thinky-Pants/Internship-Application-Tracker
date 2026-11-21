/** Acceptance 30: complete import → contact → draft → schedule → simulated send → reply → next action, without credentials. */
import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import * as s from "@/db/schema";
import { freshDb } from "./helpers";
import { MemoryStorage } from "@/lib/storage";
import { MemoryMockStore } from "@/providers/mail/mock";
import { seedDemo, resetDemo } from "@/domain/demo/seed";
import { companySummaries } from "@/domain/summary";
import { createBackup, restoreBackup } from "@/domain/backup";
import { createPgliteDb } from "@/db/pglite";

let ctx: Awaited<ReturnType<typeof freshDb>>;
afterEach(async () => ctx?.close());

describe("demo mode", () => {
  it("seeds every required state using only mock providers, and resets cleanly", async () => {
    ctx = await freshDb();
    const storage = new MemoryStorage();
    const store = new MemoryMockStore();
    await seedDemo(ctx.db, storage, store, ctx.ownerId, new Date("2027-01-20T10:00:00Z"));
    const db = ctx.db;
    const sends = await db.select().from(s.scheduledSends);
    const states = sends.map((x) => x.state);
    expect(states.filter((x) => x === "recorded_sent").length).toBeGreaterThanOrEqual(4);
    expect(states).toContain("uncertain");
    expect(states.filter((x) => x === "scheduled").length).toBe(2);
    const held = sends.find((x) => x.state === "held");
    expect(held?.holdReason).toMatch(/Follow-up held/);
    const inbound = await db.select().from(s.messages).where(eq(s.messages.direction, "inbound"));
    expect(inbound.map((m) => m.category).sort()).toEqual(["bounce", "out_of_office", "positive_interest", "rejection"]);
    const bounced = await db.select().from(s.messages).where(and(eq(s.messages.direction, "outbound"), eq(s.messages.isBounce, true)));
    expect(bounced).toHaveLength(1);
    const emails = await db.select().from(s.emailAddresses);
    expect(new Set(emails.map((e) => e.quality))).toEqual(new Set(["provider_verified", "catch_all", "unknown"]));
    const sums = await companySummaries(db, ctx.ownerId);
    const progress = [...sums.values()].map((x) => x.outreach);
    expect(progress).toContain("replied");
    expect(progress).toContain("scheduled");
    expect([...sums.values()].some((x) => x.emailAvailability === "missing")).toBe(true);
    const tasks = await db.select().from(s.tasks);
    expect(tasks.some((t) => t.kind === "replacement_contact")).toBe(true);
    // Nothing left the mock: every message is demo-flagged.
    expect((await db.select().from(s.messages)).every((m) => m.isDemo)).toBe(true);

    // Backup → restore round trip into an empty database.
    const zip = await createBackup(db, storage);
    const target = await createPgliteDb();
    const storage2 = new MemoryStorage();
    const r = await restoreBackup(target.db, storage2, zip);
    expect(r.files).toBeGreaterThan(0);
    expect((await target.db.select().from(s.messages)).length).toBe((await db.select().from(s.messages)).length);
    await target.client.close();

    await resetDemo(db);
    expect(await db.select().from(s.companies)).toHaveLength(0);
    expect(await db.select().from(s.messages)).toHaveLength(0);
  });
});
