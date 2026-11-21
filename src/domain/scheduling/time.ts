/**
 * Scheduling time rules (pure; see docs/SCHEDULING.md).
 *
 * - A schedule stores the UTC instant AND the original intent: local wall time,
 *   IANA zone and mode ("recipient_local" or "my_local"). The interpretation is
 *   always explicit.
 * - Nonexistent local times (spring-forward gap) and ambiguous ones (fall-back
 *   overlap) are detected and must be resolved by an explicit choice.
 * - Sending windows (weekdays + hours) are evaluated in the schedule's zone.
 *   Holidays are NOT considered unless a calendar source is configured (none
 *   ships by default).
 */
import { DateTime } from "luxon";

export type ScheduleMode = "recipient_local" | "my_local";
export type DstResolution = "none" | "shift_forward" | "shift_by_gap" | "earlier_offset" | "later_offset";

export interface ResolveOption {
  resolution: DstResolution;
  utc: Date;
  label: string;
}

export type ResolveResult =
  | { status: "ok"; utc: Date; offsetMinutes: number }
  | { status: "nonexistent"; explanation: string; options: ResolveOption[] }
  | { status: "ambiguous"; explanation: string; options: ResolveOption[] }
  | { status: "invalid"; explanation: string };

const LOCAL_FMT = "yyyy-MM-dd'T'HH:mm";

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/** Which UTC instants display as `local` in `zone`? 0 → gap, 2 → overlap. */
function instantsFor(local: string, zone: string): { utc: number; offset: number }[] {
  const naive = DateTime.fromFormat(local, LOCAL_FMT, { zone: "UTC" });
  if (!naive.isValid) return [];
  const base = naive.toMillis();
  const offsets = new Set<number>();
  for (const h of [-36, -24, -12, -6, -3, 0, 3, 6, 12, 24, 36]) offsets.add(DateTime.fromMillis(base + h * 3600_000, { zone }).offset);
  const out: { utc: number; offset: number }[] = [];
  for (const off of [...offsets].sort((a, b) => b - a)) {
    const utc = base - off * 60_000;
    const back = DateTime.fromMillis(utc, { zone });
    if (back.toFormat(LOCAL_FMT) === local && back.offset === off) out.push({ utc, offset: off });
  }
  return out.sort((a, b) => a.utc - b.utc);
}

export function resolveLocalTime(local: string, zone: string, resolution: DstResolution = "none"): ResolveResult {
  if (!isValidZone(zone)) return { status: "invalid", explanation: `Unknown timezone "${zone}".` };
  if (!DateTime.fromFormat(local, LOCAL_FMT).isValid) return { status: "invalid", explanation: `"${local}" is not a valid local date/time (YYYY-MM-DDTHH:mm).` };
  const found = instantsFor(local, zone);
  if (found.length === 1) return { status: "ok", utc: new Date(found[0].utc), offsetMinutes: found[0].offset };

  if (found.length === 0) {
    // Gap: find the transition and offer the first valid minute after it, or a shift by the gap length.
    const naive = DateTime.fromFormat(local, LOCAL_FMT, { zone: "UTC" }).toMillis();
    const before = DateTime.fromMillis(naive - 12 * 3600_000, { zone }).offset;
    const after = DateTime.fromMillis(naive + 12 * 3600_000, { zone }).offset;
    const gapMin = after - before;
    const transitionUtc = naive - before * 60_000; // instant where local would have been `local` under old offset
    // First valid local minute after the gap = the transition instant itself.
    let t = transitionUtc - gapMin * 60_000;
    while (DateTime.fromMillis(t, { zone }).offset !== after) t += 60_000;
    const options: ResolveOption[] = [
      { resolution: "shift_forward", utc: new Date(t), label: `Use ${DateTime.fromMillis(t, { zone }).toFormat("HH:mm")} (first valid time after the clock change)` },
      { resolution: "shift_by_gap", utc: new Date(transitionUtc), label: `Use ${DateTime.fromMillis(transitionUtc, { zone }).toFormat("HH:mm")} (shift by the ${gapMin}-minute gap)` },
    ];
    const chosen = options.find((o) => o.resolution === resolution);
    if (chosen) return { status: "ok", utc: chosen.utc, offsetMinutes: after };
    return { status: "nonexistent", explanation: `${local} does not exist in ${zone}: clocks jump forward ${gapMin} minutes that day.`, options };
  }

  const [first, second] = found;
  const options: ResolveOption[] = [
    { resolution: "earlier_offset", utc: new Date(first.utc), label: `First occurrence (UTC${fmtOffset(first.offset)}, before clocks go back)` },
    { resolution: "later_offset", utc: new Date(second.utc), label: `Second occurrence (UTC${fmtOffset(second.offset)}, after clocks go back)` },
  ];
  const chosen = options.find((o) => o.resolution === resolution);
  if (chosen) return { status: "ok", utc: chosen.utc, offsetMinutes: chosen === options[0] ? first.offset : second.offset };
  return { status: "ambiguous", explanation: `${local} occurs twice in ${zone}: clocks go back that day.`, options };
}

function fmtOffset(min: number): string {
  const sign = min >= 0 ? "+" : "-";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function formatInZone(d: Date, zone: string, fmt = "ccc d LLL yyyy, HH:mm ZZZZ"): string {
  return DateTime.fromJSDate(d, { zone }).toFormat(fmt);
}

export function toLocalIntent(d: Date, zone: string): string {
  return DateTime.fromJSDate(d, { zone }).toFormat(LOCAL_FMT);
}

/** Next occurrence of an ISO weekday (1=Mon) at HH:mm in zone, strictly after `from`. */
export function nextWeekdayAt(from: Date, zone: string, isoWeekday: number, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  let d = DateTime.fromJSDate(from, { zone }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  while (d.weekday !== isoWeekday || d.toMillis() <= from.getTime()) d = d.plus({ days: 1 }).set({ hour: h, minute: m });
  return d.toFormat(LOCAL_FMT);
}

// ───────────────────────── Sending windows ─────────────────────────
export interface SendingWindow {
  days: number[]; // ISO weekdays allowed (1=Mon … 7=Sun)
  start: string;  // "HH:mm" inclusive
  end: string;    // "HH:mm" exclusive
}

function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinWindow(utc: Date, zone: string, w: SendingWindow): boolean {
  const d = DateTime.fromJSDate(utc, { zone });
  const mins = d.hour * 60 + d.minute;
  return w.days.includes(d.weekday) && mins >= minutesOf(w.start) && mins < minutesOf(w.end);
}

/**
 * First instant ≥ utc inside the window. Rule: if before today's start on an
 * allowed day → today's start; if after end or on a disallowed day → the start
 * of the next allowed day. Window starts that fall in a DST gap use the first
 * valid minute after the gap.
 */
export function nextEligibleInstant(utc: Date, zone: string, w: SendingWindow): Date {
  if (!w.days.length) throw new Error("Sending window has no allowed days.");
  if (isWithinWindow(utc, zone, w)) return utc;
  let d = DateTime.fromJSDate(utc, { zone });
  for (let i = 0; i < 15; i++) {
    const startLocal = d.toFormat("yyyy-MM-dd") + "T" + w.start;
    const r = resolveLocalTime(startLocal, zone, "shift_forward");
    const r2 = r.status === "ambiguous" ? resolveLocalTime(startLocal, zone, "earlier_offset") : r;
    if (r2.status === "ok" && w.days.includes(d.weekday) && r2.utc.getTime() >= utc.getTime()) return r2.utc;
    d = d.plus({ days: 1 }).startOf("day");
  }
  throw new Error("No eligible sending time found within two weeks.");
}

// ───────────────────────── Batch spreading ─────────────────────────
export interface MailboxLimits {
  dailyLimit: number;
  hourlyLimit: number;
  minSpacingSeconds: number;
}

export interface BatchItem {
  id: string;
  desiredUtc: Date;
  zone: string; // zone whose sending window applies (recipient zone in recipient-local mode)
}

export interface BatchAssignment {
  id: string;
  desiredUtc: Date;
  plannedUtc: Date;
  shiftedMinutes: number;
  reasons: string[];
}

/**
 * Greedy spread respecting min spacing, rolling hourly limit, daily limit
 * (days bucketed in `limitZone`, the mailbox owner's zone) and each item's
 * sending window. `existing` = already-planned instants for the same mailbox.
 */
export function planBatch(items: BatchItem[], limits: MailboxLimits, window: SendingWindow | null, limitZone: string, existing: Date[] = []): BatchAssignment[] {
  const taken = existing.map((d) => d.getTime()).sort((a, b) => a - b);
  const spacing = Math.max(0, limits.minSpacingSeconds) * 1000;
  const dayKey = (t: number) => DateTime.fromMillis(t, { zone: limitZone }).toFormat("yyyy-MM-dd");
  const out: BatchAssignment[] = [];
  for (const item of [...items].sort((a, b) => a.desiredUtc.getTime() - b.desiredUtc.getTime() || a.id.localeCompare(b.id))) {
    let t = item.desiredUtc.getTime();
    const reasons = new Set<string>();
    for (let guard = 0; guard < 10_000; guard++) {
      if (window) {
        const e = nextEligibleInstant(new Date(t), item.zone, window).getTime();
        if (e !== t) reasons.add("outside sending window");
        t = e;
      }
      const conflict = taken.find((x) => Math.abs(x - t) < spacing);
      if (conflict !== undefined) {
        t = conflict + spacing;
        reasons.add(`minimum spacing ${limits.minSpacingSeconds}s`);
        continue;
      }
      const inHour = taken.filter((x) => x > t - 3600_000 && x <= t);
      if (inHour.length >= limits.hourlyLimit) {
        t = inHour[inHour.length - limits.hourlyLimit] + 3600_000 + 1000;
        reasons.add(`hourly limit ${limits.hourlyLimit}`);
        continue;
      }
      const dk = dayKey(t);
      if (taken.filter((x) => dayKey(x) === dk).length >= limits.dailyLimit) {
        t = DateTime.fromMillis(t, { zone: limitZone }).plus({ days: 1 }).startOf("day").toMillis();
        reasons.add(`daily limit ${limits.dailyLimit}`);
        continue;
      }
      break;
    }
    taken.push(t);
    taken.sort((a, b) => a - b);
    out.push({ id: item.id, desiredUtc: item.desiredUtc, plannedUtc: new Date(t), shiftedMinutes: Math.round((t - item.desiredUtc.getTime()) / 60000), reasons: [...reasons] });
  }
  return out;
}

// ───────────────────────── Overdue policy ─────────────────────────
export type OverdueClass = "not_due" | "due" | "recent_overdue" | "stale_overdue";

/** "due" = within 2 minutes of planned; recent = within grace window (spread through limits); stale = hold for review. */
export function classifyOverdue(plannedAt: Date, now: Date, graceMinutes: number): OverdueClass {
  const late = now.getTime() - plannedAt.getTime();
  if (late < 0) return "not_due";
  if (late <= 2 * 60_000) return "due";
  if (late <= graceMinutes * 60_000) return "recent_overdue";
  return "stale_overdue";
}
