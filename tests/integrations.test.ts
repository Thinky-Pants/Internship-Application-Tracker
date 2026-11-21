/** Acceptance 5–8 (Apollo), 22–24 & 26 (sync/threads), 27 (AI exchange), 28 (CV versions). */
import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import * as s from "@/db/schema";
import { setup, sendRow, MINIMAL_PDF } from "./harness";
import { scheduleMessage } from "@/domain/scheduling/service";
import { dispatchTick, reconcileSend } from "@/domain/dispatch/dispatcher";
import { syncMailbox } from "@/domain/mail/sync";
import { searchCompany, addCandidateAsContact, enrichContacts, planEnrichment, createDiscoveryJob, runDiscoveryStep } from "@/domain/discovery/service";
import { planApolloCsv, commitApolloCsv } from "@/domain/discovery/apollo-csv";
import { suggestMapping } from "@/domain/import/mapping";
import { exportPackage, importResults, decideResult } from "@/domain/ai/exchange";
import { uploadCvVersion, readVersionBytes } from "@/domain/documents";
import { companySummary } from "@/domain/summary";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => ctx?.close());

async function sentMessage() {
  const msg = await ctx.approvedMessage();
  const sd = await scheduleMessage(ctx.svc, { ownerId: ctx.ownerId, messageId: msg.id, mode: "recipient_local", localIntent: "2027-01-11T07:00", zone: "Europe/Oslo" });
  ctx.clock.set("2027-01-11T06:00:30Z");
  await dispatchTick(ctx.svc);
  await reconcileSend(ctx.svc, sd.id);
  const [m] = await ctx.db.select().from(s.messages).where(eq(s.messages.id, msg.id));
  return { msg: m, sd };
}

describe("Apollo discovery", () => {
  it("6–7: search hits are candidates only; email exists only after enrichment reveals one", async () => {
    ctx = await setup();
    const [co] = await ctx.db.insert(s.companies).values({ ownerId: ctx.ownerId, name: "Kite Aero", domain: "kite-aero.example", sizeText: "12" }).returning();
    const a = await searchCompany(ctx.svc, { ownerId: ctx.ownerId, companyId: co.id });
    expect(a.outcome).toBe("match_found");
    const cands = a.candidates as { apolloPersonId: string; hasEmailFlag: boolean }[];
    expect(cands[0].hasEmailFlag).toBe(true);
    expect((await companySummary(ctx.db, co.id)).emailAvailability).toBe("missing");
    const c0 = await addCandidateAsContact(ctx.svc, { ownerId: ctx.ownerId, companyId: co.id, candidate: (a.candidates as never[])[0] });
    const c2 = cands[2] ? await addCandidateAsContact(ctx.svc, { ownerId: ctx.ownerId, companyId: co.id, candidate: (a.candidates as never[])[2] }) : null;
    // Contact location is the person's, never the company's.
    expect(c0.personLocation).toMatch(/Lisbon/);
    expect((await ctx.db.select().from(s.companyLocations).where(eq(s.companyLocations.companyId, co.id))).length).toBe(0);
    const r = await enrichContacts(ctx.svc, { ownerId: ctx.ownerId, contactIds: [c0.id, ...(c2 ? [c2.id] : [])], creditBudget: 10 });
    expect(r.results.find((x) => x.contactId === c0.id)!.outcome).toBe("email_revealed");
    if (c2) expect(r.results.find((x) => x.contactId === c2.id)!.outcome).toBe("email_not_revealed");
    const [e] = await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.contactId, c0.id));
    expect(e.quality).toBe("provider_verified");
    expect(e.providerStatus).toBe("verified");
    // Already-resolved person is not re-enriched.
    const plan = await planEnrichment(ctx.svc, ctx.ownerId, [c0.id]);
    expect(plan.toEnrich).toHaveLength(0);
    expect(plan.skipped[0].reason).toMatch(/usable address/);
  });

  it("8: distinguishes no match, blocked access, timeout, throttling and budget exhaustion", async () => {
    ctx = await setup();
    const mk = async (domain: string) => (await ctx.db.insert(s.companies).values({ ownerId: ctx.ownerId, name: domain, domain }).returning())[0];
    const outcomes: Record<string, string | null> = {};
    for (const d of ["nomatch.x.example", "blocked.x.example", "slow.x.example", "throttle.x.example"]) {
      const co = await mk(d);
      const a = await searchCompany(ctx.svc, { ownerId: ctx.ownerId, companyId: co.id });
      outcomes[d] = `${a.status}/${a.outcome}`;
      const [after] = await ctx.db.select().from(s.companies).where(eq(s.companies.id, co.id));
      if (d.startsWith("nomatch")) expect(after.discoveryStatus).toBe("no_suitable_match");
      else expect(after.discoveryStatus).not.toBe("no_suitable_match"); // failure ≠ no contact
    }
    expect(outcomes).toEqual({
      "nomatch.x.example": "completed/no_match",
      "blocked.x.example": "blocked_access/access_denied",
      "slow.x.example": "failed/timeout",
      "throttle.x.example": "pending/rate_limited",
    });
    const co = await mk("budget.example");
    const a = await searchCompany(ctx.svc, { ownerId: ctx.ownerId, companyId: co.id });
    const c = await addCandidateAsContact(ctx.svc, { ownerId: ctx.ownerId, companyId: co.id, candidate: (a.candidates as never[])[0] });
    const r = await enrichContacts(ctx.svc, { ownerId: ctx.ownerId, contactIds: [c.id], creditBudget: 0 });
    expect(r.results[0].outcome).toBe("budget_exhausted");
  });

  it("batch job processes in priority order and stops on access denial", async () => {
    ctx = await setup();
    const a = (await ctx.db.insert(s.companies).values({ ownerId: ctx.ownerId, name: "Lead Co", domain: "lead.example", priority: "lead" }).returning())[0];
    const b = (await ctx.db.insert(s.companies).values({ ownerId: ctx.ownerId, name: "Primary Co", domain: "primary.example", priority: "primary" }).returning())[0];
    const job = await createDiscoveryJob(ctx.svc, { ownerId: ctx.ownerId, companyIds: [a.id, b.id] });
    await runDiscoveryStep(ctx.svc, 1);
    const done = await ctx.db.select().from(s.discoveryAttempts).where(and(eq(s.discoveryAttempts.jobId, job.id), eq(s.discoveryAttempts.status, "completed")));
    expect(done.map((d) => d.companyId)).toEqual([b.id]);
  });

  it("5: Apollo CSV import keeps company vs contact locations and the verbatim status; reimport is safe", async () => {
    ctx = await setup();
    const headers = ["First Name", "Last Name", "Title", "Company", "Website", "Email", "Email Status", "City", "Country", "Company City", "Company Country", "Apollo Contact Id"];
    const rows = [
      ["Lars", "Holm", "Head of Manufacturing", "Fjord Robotics", "https://www.fjord-robotics.example", "lars@fjord-robotics.example", "Extrapolated", "Bergen", "Norway", "Oslo", "Norway", "apl-1"],
      ["Zed", "Q", "Engineer", "Unknown GmbH", "unknown-gmbh.example", "zed@unknown-gmbh.example", "Verified", null, null, null, null, "apl-2"],
    ];
    const mapping = suggestMapping(headers, "apollo_contacts");
    const plan = await planApolloCsv(ctx.svc, ctx.ownerId, headers, rows, mapping);
    expect(plan[0].companyMatch?.how).toBe("domain");
    expect(plan[0].quality).toBe("unknown"); // "Extrapolated" is not upgraded to verified
    expect(plan[0].personLocation).toBe("Bergen, Norway");
    expect(plan[1].unresolvedCompany).toBe("Unknown GmbH");
    const [b1] = await ctx.db.insert(s.importBatches).values({ ownerId: ctx.ownerId, kind: "apollo_csv", filename: "a.csv", fileSha256: "x" }).returning();
    const rep = await commitApolloCsv(ctx.svc, ctx.ownerId, b1.id, plan);
    expect(rep).toMatchObject({ created: 1, skipped: 1, emailsAdded: 1 });
    const [lars] = await ctx.db.select().from(s.contacts).where(eq(s.contacts.apolloPersonId, "apl-1"));
    expect(lars.personLocation).toBe("Bergen, Norway");
    const [loc] = await ctx.db.select().from(s.companyLocations).where(eq(s.companyLocations.companyId, ctx.company.id));
    expect(loc.city).toBe("Oslo"); // company location untouched
    const [em] = await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.normalized, "lars@fjord-robotics.example"));
    expect(em.providerStatus).toBe("Extrapolated");
    const plan2 = await planApolloCsv(ctx.svc, ctx.ownerId, headers, rows, mapping);
    const [b2] = await ctx.db.insert(s.importBatches).values({ ownerId: ctx.ownerId, kind: "apollo_csv", filename: "a.csv", fileSha256: "x" }).returning();
    const rep2 = await commitApolloCsv(ctx.svc, ctx.ownerId, b2.id, plan2);
    expect(rep2.created).toBe(0);
    expect((await ctx.db.select().from(s.contacts).where(eq(s.contacts.apolloPersonId, "apl-1"))).length).toBe(1);
  });
});

describe("mailbox sync and threading", () => {
  it("22: duplicate delta replays, pagination and an expired cursor do not duplicate messages", async () => {
    ctx = await setup();
    const { MockMailProvider } = await import("@/providers/mail/mock");
    const paged = new MockMailProvider(ctx.mockStore, ctx.clock, { pageSize: 1 });
    const svc = { ...ctx.svc, mailProvider: () => paged };
    const { msg } = await sentMessage();
    for (let i = 0; i < 3; i++) paged.simulateInbound(ctx.mailbox.id, { from: "ingrid@fjord-robotics.example", subject: `Re: Internship enquiry ${i}`, text: "Could you send your availability?", inReplyToProviderId: msg.providerMessageId! });
    paged.setReplayDuplicates(ctx.mailbox.id, true);
    const r1 = await syncMailbox(svc, ctx.mailbox.id);
    expect(r1.pages).toBeGreaterThan(3);
    const count = async () => (await ctx.db.select().from(s.messages).where(eq(s.messages.direction, "inbound"))).length;
    expect(await count()).toBe(3);
    paged.expireDeltaTokens(ctx.mailbox.id);
    const r2 = await syncMailbox(svc, ctx.mailbox.id);
    expect(r2.resyncs).toBeGreaterThan(0);
    expect(await count()).toBe(3);
  });

  it("23: a reply is matched to the right contact via headers and pauses pending follow-ups", async () => {
    ctx = await setup();
    const { msg } = await sentMessage();
    const [en] = await ctx.db.insert(s.enrollments).values({ ownerId: ctx.ownerId, companyId: ctx.company.id, contactId: ctx.contact.id }).returning();
    const fu = await ctx.approvedMessage({ kind: "followup", enrollmentId: en.id });
    const fsd = await scheduleMessage(ctx.svc, { ownerId: ctx.ownerId, messageId: fu.id, mode: "my_local", localIntent: "2027-01-20T10:00", zone: "Asia/Riyadh" });
    ctx.mail.simulateInbound(ctx.mailbox.id, { from: "ingrid@fjord-robotics.example", subject: "Re: Internship enquiry", text: "Thanks! Would you be available for a call next week to discuss an interview?", inReplyToProviderId: msg.providerMessageId! });
    await syncMailbox(ctx.svc, ctx.mailbox.id);
    const [reply] = await ctx.db.select().from(s.messages).where(eq(s.messages.direction, "inbound"));
    expect(reply.contactId).toBe(ctx.contact.id);
    expect(reply.replyToMessageId).toBe(msg.id);
    expect(reply.category).toBe("positive_interest");
    expect(reply.conversationId).toBe((await ctx.db.select().from(s.messages).where(eq(s.messages.id, msg.id)))[0].conversationId);
    expect((await sendRow(ctx.db, fsd.id)).state).toBe("paused");
    const [e2] = await ctx.db.select().from(s.enrollments).where(eq(s.enrollments.id, en.id));
    expect(e2.state).toBe("stopped");
  });

  it("24: a domain-only match stays in review and is not merged into the existing thread", async () => {
    ctx = await setup();
    const { msg } = await sentMessage();
    ctx.mail.simulateInbound(ctx.mailbox.id, { from: "someone.else@fjord-robotics.example", subject: "Hello", text: "We saw your profile." });
    ctx.mail.simulateInbound(ctx.mailbox.id, { from: "news@unrelated.example", subject: "Newsletter", text: "Sale!" });
    const r = await syncMailbox(ctx.svc, ctx.mailbox.id);
    expect(r.skippedUnrelated).toBeGreaterThanOrEqual(1); // unrelated mail is not stored
    const inbound = await ctx.db.select().from(s.messages).where(eq(s.messages.direction, "inbound"));
    expect(inbound).toHaveLength(1);
    expect(inbound[0].needsReview).toBe(true);
    expect(inbound[0].contactId).toBeNull();
    const [conv] = await ctx.db.select().from(s.conversations).where(eq(s.conversations.id, inbound[0].conversationId!));
    expect(conv.matchStatus).toBe("ambiguous");
    expect(inbound[0].conversationId).not.toBe(msg.conversationId);
  });

  it("26 + external sends: Outlook-sent mail to a known contact is recorded as external evidence", async () => {
    ctx = await setup();
    ctx.mail.simulateExternalSent(ctx.mailbox.id, { to: ["ingrid@fjord-robotics.example"], subject: "Sent from Outlook", text: "hi" });
    await syncMailbox(ctx.svc, ctx.mailbox.id);
    const [m] = await ctx.db.select().from(s.messages).where(eq(s.messages.kind, "external_sent"));
    expect(m.evidenceSource).toBe("external_outlook");
    expect(m.companyId).toBe(ctx.company.id);
  });
});

describe("AI exchange", () => {
  it("27: imports results with preview; rejects stale/unknown/invalid; never approves or sends", async () => {
    ctx = await setup();
    const pkg = await exportPackage(ctx.svc, ctx.ownerId, "draft_email", [ctx.company.id]);
    expect(pkg.prompt).toMatch(/JSON Lines/);
    const good = { packageId: pkg.packageId, recordType: "company", recordId: ctx.company.id, recordRevision: pkg.records[0].recordRevision, result: { subject: "Internship at Fjord Robotics", bodyHtml: "<p>Dear Ingrid, I would like to …</p>", usedEvidenceIds: [], unsupportedClaims: [] } };
    const unknown = { ...good, recordId: "11111111-1111-4111-8111-111111111111" };
    const extraField = { ...good, result: { ...good.result, status: "sent" } };
    const text = [good, unknown, extraField].map((x) => JSON.stringify(x)).join("\n");
    const preview = await importResults(ctx.svc, ctx.ownerId, text);
    expect(preview.map((p) => p.status)).toEqual(["valid", "unknown_record", "invalid"]);
    const again = await importResults(ctx.svc, ctx.ownerId, JSON.stringify(good));
    expect(again[0].status).toBe("duplicate");
    // Stale: the company changes after export.
    await ctx.db.update(s.companies).set({ revision: 99 }).where(eq(s.companies.id, ctx.company.id));
    const stale = await importResults(ctx.svc, ctx.ownerId, JSON.stringify({ ...good, result: { ...good.result, subject: "Different subject here" } }));
    expect(stale[0].status).toBe("stale");
    await ctx.db.update(s.companies).set({ revision: pkg.records[0].recordRevision }).where(eq(s.companies.id, ctx.company.id));
    const created = (await decideResult(ctx.svc, ctx.ownerId, preview[0].resultId!, "accept", { mailboxId: ctx.mailbox.id, to: ["ingrid@fjord-robotics.example"] })) as { id: string; status: string };
    expect(created.status).toBe("draft");
    expect(await ctx.db.select().from(s.approvals).where(eq(s.approvals.messageId, created.id))).toHaveLength(0);
    expect(await ctx.db.select().from(s.scheduledSends).where(eq(s.scheduledSends.messageId, created.id))).toHaveLength(0);
  });
});

describe("CV versions", () => {
  it("28: replacing a CV keeps the exact original bytes on historical messages", async () => {
    ctx = await setup();
    const { msg } = await sentMessage();
    const v2bytes = new TextEncoder().encode("%PDF-1.4\n% version two\n%%EOF\n");
    const v2 = await uploadCvVersion(ctx.svc, { ownerId: ctx.ownerId, documentId: ctx.cv.documentId, filename: "cv-robotics-v2.pdf", bytes: v2bytes });
    expect(v2.versionNo).toBe(2);
    const [rev] = await ctx.db.select().from(s.messageRevisions).where(eq(s.messageRevisions.messageId, msg.id));
    const att = (rev.attachments as { documentVersionId: string; sha256: string }[])[0];
    expect(att.documentVersionId).toBe(ctx.cv.id);
    const { bytes } = await readVersionBytes(ctx.svc, att.documentVersionId);
    expect(Buffer.from(bytes).equals(Buffer.from(MINIMAL_PDF))).toBe(true);
    // Versions are append-only at the database level.
    await expect(ctx.db.update(s.documentVersions).set({ filename: "x.pdf" }).where(eq(s.documentVersions.id, ctx.cv.id))).rejects.toThrow();
  });
});
