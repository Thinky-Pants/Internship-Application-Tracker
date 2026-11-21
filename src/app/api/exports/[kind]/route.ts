import { desc, eq, inArray } from "drizzle-orm";
import * as s from "@/db/schema";
import { getDb } from "@/db/client";
import { apiOwner, download, handler } from "@/server/http";
import { listCompanies, parseFilter } from "@/server/queries";
import { toCsv } from "@/domain/import/xlsx-write";

export const GET = handler(async (req: Request, ctx: { params: Promise<{ kind: string }> }) => {
  const owner = await apiOwner();
  const { kind } = await ctx.params;
  const db = getDb();
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  let rows: (string | number | null)[][] = [];
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  if (kind === "companies") {
    const list = await listCompanies(owner.id, parseFilter(sp));
    rows = [["company_id", "external_id", "name", "domain", "priority", "industry", "region", "country", "city", "fit_score", "contacts", "email_availability", "best_quality", "outreach_progress", "imported_outreach_status", "discovery_status", "contacted_at", "last_activity"],
      ...list.map(({ company: c, summary: m }) => [c.id, c.externalId, c.name, c.domain, c.priority, c.industryPrimary, c.regionGroup, c.country, c.city, c.fitScore, m.contactCount, m.emailAvailability, m.bestQuality, m.outreach, c.importedOutreachStatus, c.discoveryStatus, iso(m.contactedAt), iso(m.lastActivityAt)])];
    await db.insert(s.exportBatches).values({ ownerId: owner.id, kind, filters: sp, rowCount: list.length });
  } else if (kind === "contacts") {
    const cs = await db.select({ ct: s.contacts, co: s.companies }).from(s.contacts).innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId)).where(eq(s.contacts.ownerId, owner.id));
    const em = await db.select().from(s.emailAddresses).where(eq(s.emailAddresses.ownerId, owner.id));
    rows = [["company", "domain", "contact", "title", "source", "apollo_person_id", "email", "quality", "provider_status", "bounce", "suppressed"],
      ...cs.flatMap(({ ct, co }) => {
        const es = em.filter((e) => e.contactId === ct.id);
        return (es.length ? es : [null]).map((e) => [co.name, co.domain, ct.fullName, ct.title, ct.source, ct.apolloPersonId, e?.address ?? null, e?.quality ?? null, e?.providerStatus ?? null, e?.bounceState ?? null, e ? String(e.suppressed) : null]);
      })];
  } else if (kind === "outreach") {
    const ms = await db.select({ m: s.messages, co: s.companies }).from(s.messages).leftJoin(s.companies, eq(s.companies.id, s.messages.companyId)).where(eq(s.messages.ownerId, owner.id)).orderBy(desc(s.messages.createdAt));
    rows = [["message_id", "company", "direction", "kind", "status", "subject", "to", "from", "submitted_at", "recorded_sent_at", "received_at", "evidence_source", "category", "bounced"],
      ...ms.map(({ m, co }) => [m.id, co?.name ?? null, m.direction, m.kind, m.status, m.subject, (m.toAddresses as string[]).join("; "), m.fromAddress, iso(m.submittedAt), iso(m.recordedSentAt), iso(m.receivedAt), m.evidenceSource, m.category, String(m.isBounce)])];
  } else if (kind === "schedule") {
    const sd = await db.select().from(s.scheduledSends).where(eq(s.scheduledSends.ownerId, owner.id)).orderBy(desc(s.scheduledSends.plannedAt));
    const ms = sd.length ? await db.select().from(s.messages).where(inArray(s.messages.id, sd.map((x) => x.messageId))) : [];
    rows = [["send_id", "subject", "to", "state", "planned_at_utc", "intent_local", "intent_zone", "mode", "dispatch_started_at", "submitted_at", "recorded_sent_at", "attempts", "hold_reason"],
      ...sd.map((x) => {
        const m = ms.find((y) => y.id === x.messageId);
        return [x.id, m?.subject ?? null, ((m?.toAddresses as string[]) ?? []).join("; "), x.state, iso(x.plannedAt), x.intentLocal, x.intentZone, x.mode, iso(x.dispatchStartedAt), iso(x.submittedAt), iso(x.recordedSentAt), x.attemptCount, x.holdReason];
      })];
  } else if (kind === "import-template") {
    rows = [["Company_ID", "Company_Name", "Website_URL", "Canonical_Domain", "Geographical_Group", "HQ_Country_or_Territory", "HQ_City", "Primary_Industry", "Sector_Tags", "Employee_Count_or_Range", "Notes", "Contact_Name", "Contact_Title", "Contact_Email"],
      ["COMP-0001", "Example Robotics", "https://example-robotics.com", "example-robotics.com", "Europe", "Germany", "Munich", "Robotics and automation", "Robotics; Automation", "12", "", "", "", ""]];
  } else return new Response("Unknown export", { status: 404 });
  return download(toCsv(rows), `${kind}-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv; charset=utf-8");
});
