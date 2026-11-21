/** Acceptance 10–12 (time rules): recipient-local scheduling, DST gaps/overlaps, spreading. */
import { describe, it, expect } from "vitest";
import {
  resolveLocalTime, nextEligibleInstant, planBatch, classifyOverdue, nextWeekdayAt, formatInZone, isWithinWindow,
} from "@/domain/scheduling/time";

describe("local time resolution", () => {
  it("resolves an ordinary local time to one UTC instant", () => {
    const r = resolveLocalTime("2027-01-11T07:00", "Europe/Berlin");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.utc.toISOString()).toBe("2027-01-11T06:00:00.000Z");
  });

  it("detects a nonexistent local time and requires a concrete resolution", () => {
    const r = resolveLocalTime("2027-03-14T02:30", "America/New_York");
    expect(r.status).toBe("nonexistent");
    if (r.status !== "nonexistent") return;
    expect(r.options.map((o) => o.resolution)).toEqual(["shift_forward", "shift_by_gap"]);
    const fwd = resolveLocalTime("2027-03-14T02:30", "America/New_York", "shift_forward");
    const gap = resolveLocalTime("2027-03-14T02:30", "America/New_York", "shift_by_gap");
    expect(fwd.status === "ok" && fwd.utc.toISOString()).toBe("2027-03-14T07:00:00.000Z"); // 03:00 EDT
    expect(gap.status === "ok" && gap.utc.toISOString()).toBe("2027-03-14T07:30:00.000Z"); // 03:30 EDT
  });

  it("detects an ambiguous local time and offers both occurrences deterministically", () => {
    // Europe/London 2027-10-31: clocks go back 02:00 BST → 01:00 GMT, so 01:30 occurs twice; 02:30 once.
    expect(resolveLocalTime("2027-10-31T02:30", "Europe/London").status).toBe("ok");
    const amb = resolveLocalTime("2027-10-31T01:30", "Europe/London");
    expect(amb.status).toBe("ambiguous");
    const e = resolveLocalTime("2027-10-31T01:30", "Europe/London", "earlier_offset");
    const l = resolveLocalTime("2027-10-31T01:30", "Europe/London", "later_offset");
    expect(e.status === "ok" && e.utc.toISOString()).toBe("2027-10-31T00:30:00.000Z");
    expect(l.status === "ok" && l.utc.toISOString()).toBe("2027-10-31T01:30:00.000Z");
  });

  it("finds next Monday 07:00 in a recipient zone and displays both zones", () => {
    const from = new Date("2027-01-06T12:00:00Z"); // Wednesday
    expect(nextWeekdayAt(from, "Asia/Tokyo", 1, "07:00")).toBe("2027-01-11T07:00");
    const r = resolveLocalTime("2027-01-11T07:00", "Asia/Tokyo");
    expect(r.status === "ok" && formatInZone(r.utc, "Asia/Riyadh", "ccc HH:mm")).toBe("Mon 01:00");
    expect(r.status === "ok" && formatInZone(r.utc, "Asia/Tokyo", "ccc HH:mm")).toBe("Mon 07:00");
  });
});

describe("sending windows", () => {
  const w = { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" };
  it("moves weekend times to Monday window start in that zone", () => {
    const sat = new Date("2027-01-09T10:00:00Z");
    const next = nextEligibleInstant(sat, "Europe/Paris", w);
    expect(next.toISOString()).toBe("2027-01-11T07:00:00.000Z");
    expect(isWithinWindow(next, "Europe/Paris", w)).toBe(true);
  });
  it("keeps an instant already in the window", () => {
    const t = new Date("2027-01-12T09:00:00Z");
    expect(nextEligibleInstant(t, "Europe/Paris", w).toISOString()).toBe(t.toISOString());
  });
});

describe("batch spreading", () => {
  it("applies spacing, hourly and daily limits without bursts", () => {
    const desired = new Date("2027-01-11T06:00:00Z");
    const items = Array.from({ length: 14 }, (_, i) => ({ id: `m${String(i).padStart(2, "0")}`, desiredUtc: desired, zone: "Europe/Berlin" }));
    const out = planBatch(items, { dailyLimit: 12, hourlyLimit: 5, minSpacingSeconds: 300 }, { days: [1, 2, 3, 4, 5], start: "07:00", end: "18:00" }, "Asia/Riyadh");
    const times = out.map((o) => o.plannedUtc.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(300_000);
    for (const t of times) expect(times.filter((x) => x > t - 3600_000 && x <= t).length).toBeLessThanOrEqual(5);
    const byDay = new Map<string, number>();
    for (const o of out) byDay.set(formatInZone(o.plannedUtc, "Asia/Riyadh", "yyyy-MM-dd"), (byDay.get(formatInZone(o.plannedUtc, "Asia/Riyadh", "yyyy-MM-dd")) ?? 0) + 1);
    expect(Math.max(...byDay.values())).toBeLessThanOrEqual(12);
    expect(out.some((o) => o.reasons.includes("hourly limit 5"))).toBe(true);
    expect(out.some((o) => o.reasons.includes("daily limit 12"))).toBe(true);
    // Deterministic for identical input.
    const again = planBatch(items, { dailyLimit: 12, hourlyLimit: 5, minSpacingSeconds: 300 }, { days: [1, 2, 3, 4, 5], start: "07:00", end: "18:00" }, "Asia/Riyadh");
    expect(again.map((a) => a.plannedUtc.toISOString())).toEqual(out.map((a) => a.plannedUtc.toISOString()));
  });
});

describe("overdue classification", () => {
  it("separates recent overdue (spread) from stale overdue (hold)", () => {
    const p = new Date("2027-01-11T06:00:00Z");
    expect(classifyOverdue(p, new Date("2027-01-11T05:00:00Z"), 120)).toBe("not_due");
    expect(classifyOverdue(p, new Date("2027-01-11T06:01:00Z"), 120)).toBe("due");
    expect(classifyOverdue(p, new Date("2027-01-11T07:00:00Z"), 120)).toBe("recent_overdue");
    expect(classifyOverdue(p, new Date("2027-01-11T09:00:00Z"), 120)).toBe("stale_overdue");
  });
});
