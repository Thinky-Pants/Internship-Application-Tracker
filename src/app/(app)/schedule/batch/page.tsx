import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { getServices } from "@/server/runtime";
import { previewBatch } from "@/domain/scheduling/service";
import { Button, Field, fmtDate, Notice, PageHeader, Section } from "@/components/ui";
import { Flash } from "@/components/flash";
import { batchScheduleAction } from "@/app/actions/drafts";
import type { ScheduleMode, DstResolution } from "@/domain/scheduling/time";

export const metadata = { title: "Schedule batch" };
const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default async function BatchSchedule({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const all = (k: string) => (Array.isArray(sp[k]) ? (sp[k] as string[]) : sp[k] ? [sp[k] as string] : []);
  const one = (k: string, d: string) => (Array.isArray(sp[k]) ? (sp[k] as string[])[0] : (sp[k] as string)) ?? d;
  const ids = all("messageId");
  const [st] = await getDb().select().from(s.settings).where(eq(s.settings.ownerId, owner.id));
  const mode = one("mode", "recipient_local") as ScheduleMode;
  const when = one("when", "weekday");
  const zoneOverrides: Record<string, string> = {};
  const dst: Record<string, DstResolution> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (k.startsWith("zone-") && v) zoneOverrides[k.slice(5)] = String(v);
    if (k.startsWith("dst-") && v) dst[k.slice(4)] = String(v) as DstResolution;
  }
  const excluded = all("exclude");
  const preview = ids.length ? await previewBatch(getServices(), { ownerId: owner.id, messageIds: ids, mode, nextWeekday: when === "weekday" ? Number(one("weekday", "1")) : undefined, localDate: when === "date" ? one("date", "") : undefined, time: one("time", "07:00"), zoneOverrides, dstResolutions: dst, excluded }) : [];
  const ok = preview.filter((p) => !p.issues.length && !p.excluded);
  return (
    <>
      <PageHeader title="Schedule a reviewed batch" subtitle="Preview exact planned times before anything is queued." actions={<Link href="/drafts">Back to drafts</Link>} />
      <Flash sp={sp as Record<string, string>} />
      {!ids.length && <Notice>Select approved messages in Drafts & Review first.</Notice>}
      <form method="get" action="/schedule/batch">
        {ids.map((id) => <input key={id} type="hidden" name="messageId" value={id} />)}
        <Section title="When" actions={<Button type="submit">Update preview</Button>}>
          <div className="flex flex-wrap items-end gap-3">
            <fieldset className="text-[13px]"><legend className="text-[12px] text-muted">Interpret the time in</legend>
              <label className="mr-3 text-fg"><input type="radio" name="mode" value="recipient_local" defaultChecked={mode === "recipient_local"} /> each recipient’s business timezone</label>
              <label className="text-fg"><input type="radio" name="mode" value="my_local" defaultChecked={mode === "my_local"} /> my timezone ({st.displayTimezone})</label>
            </fieldset>
            <fieldset className="text-[13px]"><legend className="text-[12px] text-muted">Date</legend>
              <label className="mr-2 text-fg"><input type="radio" name="when" value="weekday" defaultChecked={when === "weekday"} /> next</label>
              <select name="weekday" defaultValue={one("weekday", "1")} aria-label="Weekday">{DAYS.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
              <label className="ml-3 mr-2 text-fg"><input type="radio" name="when" value="date" defaultChecked={when === "date"} /> on</label>
              <input type="date" name="date" defaultValue={one("date", "")} aria-label="Date" />
            </fieldset>
            <Field label="Local time" htmlFor="b-time"><input id="b-time" type="time" name="time" defaultValue={one("time", "07:00")} /></Field>
          </div>
          <p className="mt-2 text-[11px] text-muted">The next eligible date is the first matching weekday strictly after now in each recipient’s timezone. Times are then spread per mailbox through its daily/hourly limits and minimum spacing, and moved into your sending window ({(st.sendingWindow as { start: string; end: string }).start}–{(st.sendingWindow as { start: string; end: string }).end}). Holidays are not considered.</p>
        </Section>
        {preview.length > 0 && (
          <Section title={`Preview — ${ok.length} will be scheduled`} className="mt-3">
            <table className="data">
              <thead><tr><th>Exclude</th><th>Company / to</th><th>Recipient timezone</th><th>Requested (local)</th><th>Planned (recipient)</th><th>Planned (you)</th><th>Shift</th><th>Issues</th></tr></thead>
              <tbody>{preview.map((p) => (
                <tr key={p.messageId} className={p.excluded ? "opacity-50" : ""}>
                  <td><input type="checkbox" name="exclude" value={p.messageId} defaultChecked={p.excluded} aria-label="Exclude" /></td>
                  <td>{p.companyName}<div className="text-[11px] text-muted">{p.to.join(", ")}</div></td>
                  <td><input name={`zone-${p.messageId}`} defaultValue={zoneOverrides[p.messageId] ?? p.zone ?? ""} placeholder="Choose IANA zone" className="w-40" aria-label="Recipient timezone" /><div className="text-[11px] text-muted">{p.zoneExplanation}</div></td>
                  <td className="tabular-nums">{p.localIntent?.replace("T", " ") ?? "—"}</td>
                  <td className="tabular-nums">{p.plannedUtc && p.zone ? fmtDate(p.plannedUtc, p.zone) : "—"}</td>
                  <td className="tabular-nums">{p.plannedUtc ? fmtDate(p.plannedUtc, st.displayTimezone) : "—"}</td>
                  <td className="text-[11px]">{p.shiftedMinutes ? `+${p.shiftedMinutes} min (${p.reasons.join(", ")})` : p.reasons.join(", ")}</td>
                  <td className="text-[11px] text-danger">{p.issues.join(" ")}{p.dstOptions && (
                    <select name={`dst-${p.messageId}`} defaultValue="" aria-label="DST resolution"><option value="">Resolve DST…</option>{p.dstOptions.map((o) => <option key={o.resolution} value={o.resolution}>{o.label}</option>)}</select>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          </Section>
        )}
      </form>
      {ok.length > 0 && (
        <form action={batchScheduleAction} className="mt-3">
          {Object.entries(sp).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x, i) => <input key={`${k}-${i}`} type="hidden" name={k} value={x} />))}
          <input type="hidden" name="confirm" value="1" />
          <Button variant="primary" type="submit">Schedule {ok.length} messages exactly as previewed</Button>
        </form>
      )}
    </>
  );
}
