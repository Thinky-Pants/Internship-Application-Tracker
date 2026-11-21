import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Db } from "@/db/client";
import { FakeClock } from "@/lib/clock";
import { MemoryStorage } from "@/lib/storage";
import { MemoryMockStore, MockMailProvider } from "@/providers/mail/mock";
import { MockApolloProvider } from "@/providers/apollo/mock";
import { MockAiProvider } from "@/providers/ai/mock";
import type { Services } from "@/domain/services";
import { uploadCvVersion } from "@/domain/documents";
import { createMessage, approveCurrentRevision } from "@/domain/messages/compose";
import { freshDb } from "./helpers";

export const MINIMAL_PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

export async function setup(start = "2027-01-11T05:00:00Z") {
  const base = await freshDb();
  const clock = new FakeClock(start);
  const mockStore = new MemoryMockStore();
  const mail = new MockMailProvider(mockStore, clock);
  const apollo = new MockApolloProvider();
  const storage = new MemoryStorage();
  const make = (workerId: string): Services => ({
    db: base.db, clock, storage, workerId,
    mailProvider: () => mail,
    apollo: async () => apollo,
    ai: async () => new MockAiProvider(),
  });
  const svc = make("worker-A");
  const { db, ownerId } = base;
  // Permissive sending window for most tests (every day, all hours).
  await db.update(s.settings).set({ sendingWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "23:59" }, displayTimezone: "Asia/Riyadh" }).where(eq(s.settings.ownerId, ownerId));
  const [mailbox] = await db.insert(s.mailboxes).values({ ownerId, provider: "mock", emailAddress: "demo.student@example.test", status: "connected", dailyLimit: 50, hourlyLimit: 20, minSpacingSeconds: 0, lastSyncAt: clock.now() }).returning();
  const [company] = await db.insert(s.companies).values({ ownerId, name: "Fjord Robotics", domain: "fjord-robotics.example", country: "Norway", countryCode: "NO", city: "Oslo", priority: "primary" }).returning();
  await db.insert(s.companyLocations).values({ companyId: company.id, kind: "hq", city: "Oslo", country: "Norway", timezone: "Europe/Oslo", isPrimary: true, precision: "city" });
  const [contact] = await db.insert(s.contacts).values({ ownerId, companyId: company.id, fullName: "Ingrid Berg", firstName: "Ingrid", title: "CTO" }).returning();
  await db.insert(s.emailAddresses).values({ ownerId, companyId: company.id, contactId: contact.id, address: "ingrid@fjord-robotics.example", normalized: "ingrid@fjord-robotics.example", source: "apollo_api", quality: "provider_verified" });
  const cv = await uploadCvVersion(svc, { ownerId, title: "Robotics CV", filename: "cv-robotics.pdf", bytes: MINIMAL_PDF });

  async function approvedMessage(opts: { to?: string; companyId?: string; contactId?: string; subject?: string; kind?: string; enrollmentId?: string } = {}) {
    const { message } = await createMessage(svc, {
      ownerId, companyId: opts.companyId ?? company.id, contactId: opts.contactId ?? contact.id, kind: opts.kind, enrollmentId: opts.enrollmentId,
      content: { subject: opts.subject ?? "Internship enquiry", bodyHtml: "<p>Hello Ingrid</p>", to: [opts.to ?? "ingrid@fjord-robotics.example"], cc: [], mailboxId: mailbox.id, attachmentVersionIds: [cv.id] },
    });
    await approveCurrentRevision(svc, { ownerId, messageId: message.id });
    return message;
  }
  return { ...base, clock, svc, make, mail, mockStore, apollo, storage, mailbox, company, contact, cv, approvedMessage };
}

export async function sendRow(db: Db, id: string) {
  const [r] = await db.select().from(s.scheduledSends).where(eq(s.scheduledSends.id, id));
  return r;
}
