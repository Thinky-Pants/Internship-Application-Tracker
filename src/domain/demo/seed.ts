/**
 * Isolated demo data (all rows is_demo = true, mock mailbox only). Drives the
 * real domain services with a simulated clock so every state is genuine:
 * nothing is sent to a real provider and no paid credits are used.
 */
import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import * as s from "@/db/schema";
import type { Db } from "@/db/client";
import { FakeClock } from "@/lib/clock";
import type { Storage } from "@/lib/storage";
import { MockMailProvider, type MockStore } from "@/providers/mail/mock";
import { MockApolloProvider } from "@/providers/apollo/mock";
import { MockAiProvider } from "@/providers/ai/mock";
import type { Services } from "../services";
import { uploadCvVersion } from "../documents";
import { createMessage, approveCurrentRevision } from "../messages/compose";
import { scheduleMessage } from "../scheduling/service";
import { dispatchTick, reconcileSend } from "../dispatch/dispatcher";
import { syncMailbox, ensureFolders } from "../mail/sync";
import { renderTemplate } from "../templates";
import { buildTemplateValues } from "../outreach/personalize";
import { lookupCountry, suggestTimezone } from "../normalize";

const DEMO_PDF = new TextEncoder().encode("%PDF-1.4\n% Demo CV - fictitious\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n");

const COMPANIES = [
  { name: "Fjordline Robotics", domain: "fjordline-robotics.example", country: "Norway", city: "Oslo", lat: 59.91, lng: 10.75, industry: "Robotics and automation", priority: "primary", size: "14", region: "Europe" },
  { name: "Kestrel Aero Works", domain: "kestrel-aero.example", country: "Germany", city: "Munich", lat: 48.14, lng: 11.58, industry: "Aerospace and drones", priority: "primary", size: "28", region: "Europe" },
  { name: "Volt Harbor Energy", domain: "volt-harbor.example", country: "Denmark", city: "Aarhus", lat: 56.16, lng: 10.2, industry: "Energy and storage", priority: "primary", size: "40", region: "Europe" },
  { name: "Sakura Motion Labs", domain: "sakura-motion.example", country: "Japan", city: "Osaka", lat: 34.69, lng: 135.5, industry: "Robotics and automation", priority: "primary", size: "22", region: "Other East Asia" },
  { name: "Maple Forge Manufacturing", domain: "mapleforge.example", country: "Canada", city: "Toronto", lat: 43.65, lng: -79.38, industry: "Manufacturing and materials", priority: "primary", size: "60", region: "North America" },
  { name: "Pacific Drive Systems", domain: "pacificdrive.example", country: "United States", city: "San Diego", lat: 32.72, lng: -117.16, industry: "Automotive and mobility", priority: "primary", size: "35", region: "North America" },
  { name: "Han River Thermal", domain: "hanriver-thermal.example", country: "South Korea", city: "Seoul", lat: 37.57, lng: 126.98, industry: "HVAC and thermal systems", priority: "reserve", size: "18", region: "Other East Asia" },
  { name: "Lotus Grid Tech", domain: "lotusgrid.example", country: "China", city: "Shenzhen", lat: 22.54, lng: 114.06, industry: "Energy and storage", priority: "primary", size: "45", region: "China" },
  { name: "Alpine Precision AG", domain: "alpine-precision.example", country: "Switzerland", city: null, lat: null, lng: null, industry: "Manufacturing and materials", priority: "lead", size: "12", region: "Europe" },
  { name: "Tagus Structures", domain: "tagus-structures.example", country: "Portugal", city: "Lisbon", lat: 38.72, lng: -9.14, industry: "Construction and building systems", priority: "lead", size: "9", region: "Europe" },
  { name: "Northwind Drones", domain: "northwind-drones.example", country: "Finland", city: "Espoo", lat: 60.21, lng: 24.66, industry: "Aerospace and drones", priority: "primary", size: "11", region: "Europe" },
  { name: "Cedar Hydraulics", domain: "nomatch.cedar-hydraulics.example", country: "United Kingdom", city: "Leeds", lat: 53.8, lng: -1.55, industry: "Manufacturing and materials", priority: "reserve", size: "30", region: "Europe" },
];

export async function resetDemo(db: Db) {
  // Demo messages, plus anything created by hand through a demo (mock) mailbox.
  const demoMailboxes = (await db.select({ id: s.mailboxes.id }).from(s.mailboxes).where(eq(s.mailboxes.isDemo, true))).map((m) => m.id);
  const viaDemoMailbox = demoMailboxes.length ? (await db.select({ id: s.messages.id }).from(s.messages).where(inArray(s.messages.mailboxId, demoMailboxes))).map((m) => m.id) : [];
  const demoMsgs = [...new Set([...(await db.select({ id: s.messages.id }).from(s.messages).where(eq(s.messages.isDemo, true))).map((m) => m.id), ...viaDemoMailbox])];
  if (demoMsgs.length) await db.delete(s.messages).where(inArray(s.messages.id, demoMsgs));
  await db.delete(s.conversations).where(eq(s.conversations.isDemo, true));
  await db.delete(s.tasks).where(eq(s.tasks.isDemo, true));
  await db.delete(s.enrollments).where(eq(s.enrollments.isDemo, true));
  await db.delete(s.companies).where(eq(s.companies.isDemo, true));
  const docs = (await db.select({ id: s.documents.id }).from(s.documents).where(eq(s.documents.isDemo, true))).map((d) => d.id);
  if (docs.length) {
    await db.delete(s.documentVersions).where(inArray(s.documentVersions.documentId, docs));
    await db.delete(s.documents).where(inArray(s.documents.id, docs));
  }
  await db.delete(s.templates).where(eq(s.templates.isDemo, true));
  await db.delete(s.campaigns).where(eq(s.campaigns.isDemo, true));
  const mbs = (await db.select({ id: s.mailboxes.id }).from(s.mailboxes).where(eq(s.mailboxes.isDemo, true))).map((m) => m.id);
  if (mbs.length) {
    await db.delete(s.scheduledSends).where(inArray(s.scheduledSends.mailboxId, mbs));
    await db.delete(s.mailboxes).where(inArray(s.mailboxes.id, mbs));
  }
}

export async function seedDemo(db: Db, storage: Storage, mockStore: MockStore, ownerId: string, realNow = new Date()) {
  await resetDemo(db);
  // Start the simulated clock two weeks ago (Monday 08:00 UTC, inside the sending window) so history exists.
  const start = DateTime.fromJSDate(realNow).toUTC().minus({ weeks: 2 }).startOf("week").set({ hour: 8 });
  const clock = new FakeClock(start.toJSDate());
  const mail = new MockMailProvider(mockStore, clock);
  const svc: Services = { db, clock, storage, workerId: "demo-seed", mailProvider: () => mail, apollo: async () => new MockApolloProvider(), ai: async () => new MockAiProvider() };

  await db.update(s.settings).set({ sendingWindow: { days: [1, 2, 3, 4, 5], start: "07:00", end: "18:00" } }).where(eq(s.settings.ownerId, ownerId));
  const [mailbox] = await db.insert(s.mailboxes).values({ ownerId, provider: "mock", emailAddress: "demo.student@example.test", displayName: "Demo mailbox (mock — never sends)", status: "connected", connectedAt: clock.now(), dailyLimit: 30, hourlyLimit: 8, minSpacingSeconds: 120, isDemo: true, lastSyncAt: clock.now() }).returning();
  await ensureFolders(svc, mailbox.id);
  const cv = await uploadCvVersion(svc, { ownerId, title: "DEMO — Robotics & automation CV", description: "Fictitious demo CV", industryTags: ["Robotics", "Automation", "Manufacturing"], filename: "demo-cv-robotics.pdf", bytes: DEMO_PDF, isDemo: true });
  await uploadCvVersion(svc, { ownerId, title: "DEMO — Energy & thermal CV", industryTags: ["Energy", "HVAC"], filename: "demo-cv-energy.pdf", bytes: DEMO_PDF, isDemo: true });
  const [tpl] = await db.insert(s.templates).values({ ownerId, isDemo: true, name: "DEMO initial enquiry", kind: "initial", subject: "Summer 2027 mechanical engineering internship — {{company.name}}", bodyHtml: "<p>Dear {{contact.first_name}},</p><p>{{personalization?}}</p><p>I am a mechanical engineering student looking for {{role}}. {{project?}}</p><p>I am available {{availability?}}. My CV is attached.</p>{{signature?}}" }).returning();
  const [fuTpl] = await db.insert(s.templates).values({ ownerId, isDemo: true, name: "DEMO polite follow-up", kind: "followup", subject: "", bodyHtml: "<p>Dear {{contact.first_name}},</p><p>I wanted to follow up on my note about a summer 2027 internship at {{company.name}}. I would be grateful for any pointer to the right person.</p>{{signature?}}" }).returning();
  const [seq] = await db.insert(s.sequences).values({ ownerId, name: "DEMO: one follow-up after 5 days", followups: [{ step: 1, delayDays: 5, templateId: fuTpl.id }] }).returning();
  const [campaign] = await db.insert(s.campaigns).values({ ownerId, name: "DEMO Europe spring push", isDemo: true }).returning();
  await db.insert(s.candidateProfile).values({ ownerId, data: { name: "Demo Student", education: [{ text: "BSc Mechanical Engineering (in progress) — demo data", verified: true }], skills: [{ text: "SolidWorks", verified: true }, { text: "MATLAB", verified: true }], projects: [{ name: "Demo gripper project", summary: "designed and tested a 3-finger compliant gripper (fictitious)", skills: ["Robotics"], verified: true }], availability: { text: "from June to August 2027", verified: true }, signatureHtml: "<p>Demo Student<br>demo.student@example.test</p>" } }).onConflictDoNothing();

  const ids: Record<string, string> = {};
  for (const c of COMPANIES) {
    const ci = lookupCountry(c.country);
    const [row] = await db.insert(s.companies).values({ ownerId, isDemo: true, name: c.name, domain: c.domain, website: `https://${c.domain}`, country: c.country, countryCode: ci?.code, city: c.city, industryPrimary: c.industry, priority: c.priority, sizeText: c.size, regionGroup: c.region, engineeringActivity: "builds fictitious demo hardware for testing this app", externalId: `DEMO-${c.domain}`, importedOutreachStatus: "Not contacted" }).returning();
    ids[c.name] = row.id;
    await db.insert(s.companyLocations).values({ companyId: row.id, kind: "hq", city: c.city, country: c.country, countryCode: ci?.code, lat: c.lat ?? ci?.lat ?? null, lng: c.lng ?? ci?.lng ?? null, precision: c.lat ? "city" : "country", geocodeStatus: "resolved", geocodeProvider: c.lat ? "demo" : "offline-centroid", timezone: suggestTimezone(c.country, c.city).zone, isPrimary: true, label: [c.city, c.country].filter(Boolean).join(", ") });
    await db.insert(s.opportunities).values({ ownerId, companyId: row.id, isDemo: true, season: "Summer 2027" });
  }
  const contact = async (company: string, name: string, title: string, email: string | null, quality = "provider_verified", status: string | null = "verified") => {
    const [ct] = await db.insert(s.contacts).values({ ownerId, companyId: ids[company], fullName: name, firstName: name.split(" ")[0], title, source: "apollo_csv", reviewStatus: "reviewed", isDemo: true }).returning();
    if (email) await db.insert(s.emailAddresses).values({ ownerId, companyId: ids[company], contactId: ct.id, address: email, normalized: email, source: "apollo_csv", quality, providerStatus: status });
    await db.update(s.companies).set({ discoveryStatus: "reviewed", preferredContactId: ct.id }).where(eq(s.companies.id, ids[company]));
    return ct;
  };
  const ingrid = await contact("Fjordline Robotics", "Ingrid Berg", "Co-founder & CTO", "ingrid@fjordline-robotics.example");
  await contact("Fjordline Robotics", "Ola Nordmann", "Mechanical Lead", "ola@fjordline-robotics.example", "catch_all", "accept_all");
  const lukas = await contact("Kestrel Aero Works", "Lukas Weber", "Head of Mechanical Engineering", "lukas@kestrel-aero.example");
  const mette = await contact("Volt Harbor Energy", "Mette Larsen", "Talent Partner", "mette@volt-harbor.example");
  const kenji = await contact("Sakura Motion Labs", "Kenji Mori", "CEO", "kenji@sakura-motion.example");
  const amelia = await contact("Maple Forge Manufacturing", "Amelia Chen", "Manufacturing Manager", "amelia@mapleforge.example");
  const diego = await contact("Pacific Drive Systems", "Diego Alvarez", "Engineering Manager", "diego@pacificdrive.example", "catch_all", "catch-all");
  await contact("Han River Thermal", "Ji-woo Park", "CTO", null); // search hit, no address yet
  const wei = await contact("Lotus Grid Tech", "Wei Zhang", "Founder", "wei@lotusgrid.example", "unknown", "unverified");
  const aino = await contact("Northwind Drones", "Aino Virtanen", "Co-founder", "aino@northwind-drones.example");

  const draft = async (company: string, ct: { id: string }, to: string, opts: { sequence?: boolean } = {}) => {
    const { values } = await buildTemplateValues(db, { ownerId, companyId: ids[company], contactId: ct.id, personalization: `I was interested in ${company}'s hardware work.` });
    const r = renderTemplate({ subject: tpl.subject, bodyHtml: tpl.bodyHtml }, values);
    let enrollmentId: string | null = null;
    if (opts.sequence) enrollmentId = (await db.insert(s.enrollments).values({ ownerId, companyId: ids[company], contactId: ct.id, sequenceId: seq.id, campaignId: campaign.id, isDemo: true }).returning())[0].id;
    const { message } = await createMessage(svc, { ownerId, companyId: ids[company], contactId: ct.id, templateId: tpl.id, createdBy: "template", campaignId: campaign.id, enrollmentId, isDemo: true, content: { subject: r.subject, bodyHtml: r.html, to: [to], cc: [], mailboxId: mailbox.id, attachmentVersionIds: [cv.id] } });
    return message;
  };
  const sendNow = async (m: { id: string }) => {
    await approveCurrentRevision(svc, { ownerId, messageId: m.id });
    const local = DateTime.fromJSDate(clock.now(), { zone: "UTC" }).plus({ minutes: 5 }).toFormat("yyyy-MM-dd'T'HH:mm");
    const sd = await scheduleMessage(svc, { ownerId, messageId: m.id, mode: "my_local", localIntent: local, zone: "UTC", respectWindow: false });
    clock.advanceMinutes(6);
    await dispatchTick(svc);
    await reconcileSend(svc, sd.id);
    clock.advanceMinutes(10);
    return sd;
  };

  // Week 1: four initial sends.
  const m1 = await draft("Fjordline Robotics", ingrid, "ingrid@fjordline-robotics.example");
  const m2 = await draft("Kestrel Aero Works", lukas, "lukas@kestrel-aero.example");
  const m3 = await draft("Volt Harbor Energy", mette, "mette@volt-harbor.example");
  const m4 = await draft("Sakura Motion Labs", kenji, "kenji@sakura-motion.example");
  const m5 = await draft("Northwind Drones", aino, "aino@northwind-drones.example", { sequence: true });
  for (const m of [m1, m2, m3, m4, m5]) await sendNow(m);
  const pid = async (id: string) => (await db.select().from(s.messages).where(eq(s.messages.id, id)))[0].providerMessageId!;

  // Replies arrive over the next days (deterministic, simulated).
  clock.advanceMinutes(60 * 26);
  mail.simulateInbound(mailbox.id, { from: "ingrid@fjordline-robotics.example", subject: "Re: Summer 2027 mechanical engineering internship — Fjordline Robotics", text: "Thanks for reaching out! Would you be available for a short call next week to discuss an interview?", inReplyToProviderId: await pid(m1.id) });
  mail.simulateInbound(mailbox.id, { from: "lukas@kestrel-aero.example", subject: "Re: Summer 2027 mechanical engineering internship — Kestrel Aero Works", text: "Unfortunately we are not able to offer internships for 2027. Best of luck.", inReplyToProviderId: await pid(m2.id) });
  mail.simulateInbound(mailbox.id, { from: "mette@volt-harbor.example", subject: "Automatic reply: Summer 2027 mechanical engineering internship", text: "I am out of the office until 3 March with limited access to email.", inReplyToProviderId: await pid(m3.id), headers: { "auto-submitted": "auto-replied" } });
  mail.simulateInbound(mailbox.id, { from: "mailer-daemon@mail.example.test", subject: "Undeliverable: Summer 2027 mechanical engineering internship — Sakura Motion Labs", text: "Delivery has failed to these recipients or groups: kenji@sakura-motion.example. The email address couldn't be found." });
  await syncMailbox(svc, mailbox.id);

  // Uncertain send: provider accepts but the client times out; left unreconciled for the demo.
  const m6 = await draft("Maple Forge Manufacturing", amelia, "amelia@mapleforge.example");
  await approveCurrentRevision(svc, { ownerId, messageId: m6.id });
  const sd6 = await scheduleMessage(svc, { ownerId, messageId: m6.id, mode: "my_local", localIntent: DateTime.fromJSDate(clock.now(), { zone: "UTC" }).plus({ minutes: 5 }).toFormat("yyyy-MM-dd'T'HH:mm"), zone: "UTC", respectWindow: false });
  mail.injectFault(mailbox.id, { op: "sendDraft", kind: "ambiguous", appliedBeforeError: true });
  clock.advanceMinutes(6);
  await dispatchTick(svc);
  void sd6;

  // Follow-up for Northwind (sequence) becomes due; mailbox sync goes stale → held.
  clock.advanceMinutes(60 * 24 * 5);
  const [fu] = await db.select().from(s.messages).where(and(eq(s.messages.enrollmentId, (await db.select().from(s.messages).where(eq(s.messages.id, m5.id)))[0].enrollmentId!), eq(s.messages.kind, "followup")));
  if (fu) {
    await approveCurrentRevision(svc, { ownerId, messageId: fu.id });
    const sdf = await scheduleMessage(svc, { ownerId, messageId: fu.id, mode: "my_local", localIntent: DateTime.fromJSDate(clock.now(), { zone: "UTC" }).plus({ minutes: 5 }).toFormat("yyyy-MM-dd'T'HH:mm"), zone: "UTC", respectWindow: false });
    await db.update(s.mailboxes).set({ lastSyncAt: new Date(clock.now().getTime() - 6 * 3600_000) }).where(eq(s.mailboxes.id, mailbox.id));
    clock.advanceMinutes(6);
    await dispatchTick(svc);
    void sdf;
  }

  // Future: a reviewed batch scheduled for recipient-local Monday 07:00 (next week relative to real time).
  const future = [await draft("Pacific Drive Systems", diego, "diego@pacificdrive.example"), await draft("Lotus Grid Tech", wei, "wei@lotusgrid.example")];
  const nextMonday = DateTime.fromJSDate(realNow).plus({ weeks: 1 }).startOf("week").toFormat("yyyy-MM-dd");
  for (const m of future) {
    await approveCurrentRevision(svc, { ownerId, messageId: m.id });
    const [msg] = await db.select().from(s.messages).where(eq(s.messages.id, m.id));
    const [loc] = await db.select().from(s.companyLocations).where(eq(s.companyLocations.companyId, msg.companyId!));
    await scheduleMessage(svc, { ownerId, messageId: m.id, mode: "recipient_local", localIntent: `${nextMonday}T07:00`, zone: loc.timezone ?? "UTC" });
  }
  // One draft left for review.
  await draft("Fjordline Robotics", (await db.select().from(s.contacts).where(eq(s.contacts.fullName, "Ola Nordmann")))[0], "ola@fjordline-robotics.example");
  // Mark mailbox recently synced in real time so the UI doesn't show the seed's simulated past.
  await db.update(s.mailboxes).set({ lastSyncAt: new Date(realNow.getTime() - 3 * 3600_000) }).where(eq(s.mailboxes.id, mailbox.id));
  return { mailboxId: mailbox.id, companies: COMPANIES.length };
}
