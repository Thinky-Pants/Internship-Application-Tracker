/** Gmail adapter driven by the real dispatcher, reconciliation and sync code against a fake Gmail API. */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { setup, sendRow, MINIMAL_PDF } from "./harness";
import { FakeGmail } from "./fake-gmail";
import { GmailMailProvider, buildMime, fromB64url } from "@/providers/mail/gmail";
import { encryptSecret } from "@/lib/crypto";
import { scheduleMessage } from "@/domain/scheduling/service";
import { dispatchTick, reconcileSend, resolveUncertain } from "@/domain/dispatch/dispatcher";
import { syncMailbox, ensureFolders } from "@/domain/mail/sync";
import { createMessage, approveCurrentRevision } from "@/domain/messages/compose";
import type { Services } from "@/domain/services";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => ctx?.close());

async function gmailSetup() {
  ctx = await setup();
  const fake = new FakeGmail(() => ctx.clock.now().getTime());
  const gmail = new GmailMailProvider(fake.fetch);
  const svc: Services = { ...ctx.svc, mailProvider: () => gmail };
  await ctx.db.update(s.mailboxes).set({ provider: "gmail", emailAddress: fake.email, accessTokenEnc: encryptSecret("test-access-token"), tokenExpiresAt: new Date("2030-01-01T00:00:00Z") }).where(eq(s.mailboxes.id, ctx.mailbox.id));
  await ensureFolders(svc, ctx.mailbox.id);
  return { fake, gmail, svc };
}

async function scheduled(svc: Services) {
  const msg = await ctx.approvedMessage();
  const sd = await scheduleMessage(svc, { ownerId: ctx.ownerId, messageId: msg.id, mode: "recipient_local", localIntent: "2027-01-11T07:00", zone: "Europe/Oslo" });
  ctx.clock.set("2027-01-11T06:00:30Z");
  return { msg, sd };
}

describe("MIME builder", () => {
  it("builds a multipart message with text, HTML, a PDF attachment and reply headers", () => {
    const mime = buildMime({ from: "me@gmail.example", to: ["a@b.example"], cc: [], subject: "Praktikum — Sommer", html: "<p>Hej</p>", text: "Hej", attachments: [{ filename: "cv.pdf", contentType: "application/pdf", bytes: MINIMAL_PDF }], inReplyTo: "<x@y>", references: "<w@y> <x@y>" }, "seed");
    expect(mime).toMatch(/^From: me@gmail.example\r\nTo: a@b.example\r\nSubject: =\?UTF-8\?B\?/);
    expect(mime).toContain("In-Reply-To: <x@y>\r\nReferences: <w@y> <x@y>");
    expect(mime).toContain('Content-Disposition: attachment; filename="cv.pdf"');
    const att = mime.split('filename*=UTF-8\'\'cv.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split("\r\n--")[0];
    expect(Buffer.from(att.replace(/\r\n/g, ""), "base64").equals(Buffer.from(MINIMAL_PDF))).toBe(true);
    expect(fromB64url(Buffer.from(mime).toString("base64url")).toString()).toBe(mime);
  });
});

describe("Gmail adapter end to end", () => {
  it("sends draft-first with the exact CV, records the sent copy via the thread, and sync does not duplicate it", async () => {
    const { fake, svc } = await gmailSetup();
    const { msg, sd } = await scheduled(svc);
    const r = await dispatchTick(svc);
    expect(r.submitted).toBe(1);
    expect(fake.sentMessages()).toHaveLength(1);
    expect(fake.sentMessages()[0].attachments).toEqual(["cv-robotics.pdf"]);
    expect(await reconcileSend(svc, sd.id)).toBe("recorded_sent");
    const [m] = await ctx.db.select().from(s.messages).where(eq(s.messages.id, msg.id));
    expect(m.providerMessageId).toBe(fake.sentMessages()[0].id);
    expect(m.internetMessageId).toMatch(/@mail\.gmail\.example>$/);
    await syncMailbox(svc, ctx.mailbox.id);
    const outbound = await ctx.db.select().from(s.messages).where(eq(s.messages.direction, "outbound"));
    expect(outbound).toHaveLength(1);
  });

  it("matches a reply by headers, pauses follow-ups, and threads the app's reply with In-Reply-To", async () => {
    const { fake, svc } = await gmailSetup();
    const { msg, sd } = await scheduled(svc);
    await dispatchTick(svc);
    await reconcileSend(svc, sd.id);
    const sent = fake.sentMessages()[0];
    ctx.clock.advanceMinutes(60);
    fake.deliver("Ingrid Berg <ingrid@fjord-robotics.example>", "Re: Internship enquiry", "Thanks! Could we schedule a call to discuss an interview?", { messageId: sent.id });
    await syncMailbox(svc, ctx.mailbox.id);
    const [reply] = await ctx.db.select().from(s.messages).where(eq(s.messages.direction, "inbound"));
    expect(reply.replyToMessageId).toBe(msg.id);
    expect(reply.contactId).toBe(ctx.contact.id);
    expect(reply.category).toBe("positive_interest");

    // Reply from the app in the same thread.
    const { message } = await createMessage(svc, { ownerId: ctx.ownerId, companyId: ctx.company.id, contactId: ctx.contact.id, kind: "reply", replyToMessageId: reply.id, content: { subject: "Re: Internship enquiry", bodyHtml: "<p>Happy to.</p>", to: ["ingrid@fjord-robotics.example"], cc: [], mailboxId: ctx.mailbox.id, attachmentVersionIds: [] } });
    await approveCurrentRevision(svc, { ownerId: ctx.ownerId, messageId: message.id });
    const rsd = await scheduleMessage(svc, { ownerId: ctx.ownerId, messageId: message.id, mode: "my_local", localIntent: "2027-01-11T11:00", zone: "Asia/Riyadh", respectWindow: false });
    ctx.clock.set("2027-01-11T08:00:30Z");
    // The incoming reply arrived before this reply was scheduled, so the coordination hold does not apply.
    await dispatchTick(svc);
    expect((await sendRow(ctx.db, rsd.id)).state).toBe("submitted");
    const out = fake.sentMessages().find((x) => x.text.includes("Happy to."))!;
    expect(out.threadId).toBe(sent.threadId);
    const h = Object.fromEntries(out.headers.map((x) => [x.name.toLowerCase(), x.value]));
    expect(h["in-reply-to"]).toMatch(/@sender\.example>$/);
  });

  it("a network drop after Gmail applied the send becomes uncertain and reconciles without a second send", async () => {
    const { fake, svc } = await gmailSetup();
    const { sd } = await scheduled(svc);
    fake.faults.push({ path: /^POST \/drafts\/send$/, kind: "network_after_apply" });
    const r = await dispatchTick(svc);
    expect(r.uncertain).toBe(1);
    // Owner chooses "retry same draft": the draft is gone and the sent copy is in the thread → no resend.
    await resolveUncertain(svc, ctx.ownerId, sd.id, "retry_same_draft");
    await dispatchTick(svc);
    expect(fake.sentMessages()).toHaveLength(1);
    expect(await reconcileSend(svc, sd.id)).toBe("recorded_sent");
    expect(fake.sentMessages()).toHaveLength(1);
  });

  it("holds a send whose Gmail draft was edited outside the app after approval", async () => {
    const { fake, svc } = await gmailSetup();
    const { sd } = await scheduled(svc);
    fake.faults.push({ path: /^POST \/drafts\/send$/, kind: "status", status: 429, reason: "rateLimitExceeded" });
    const r = await dispatchTick(svc);
    expect(r.deferred).toBe(1);
    const draftId = [...fake.drafts.keys()][0];
    fake.editDraftInGmail(draftId);
    ctx.clock.advanceMinutes(5);
    await ctx.db.update(s.mailboxes).set({ throttledUntil: null }).where(eq(s.mailboxes.id, ctx.mailbox.id));
    await dispatchTick(svc);
    const row = await sendRow(ctx.db, sd.id);
    expect(row.state).toBe("held");
    expect(row.holdReason).toMatch(/changed outside this app/);
    expect(fake.sentMessages()).toHaveLength(0);
  });

  it("pages through history and recovers from an expired history id without duplicates", async () => {
    const { fake, svc } = await gmailSetup();
    const { sd } = await scheduled(svc);
    await dispatchTick(svc);
    await reconcileSend(svc, sd.id);
    await syncMailbox(svc, ctx.mailbox.id); // establishes history cursors
    const sent = fake.sentMessages()[0];
    for (let i = 0; i < 5; i++) {
      ctx.clock.advanceMinutes(1);
      fake.deliver("ingrid@fjord-robotics.example", `Re: Internship enquiry ${i}`, "A question for you?", { messageId: sent.id });
    }
    const r1 = await syncMailbox(svc, ctx.mailbox.id);
    expect(r1.errors).toEqual([]);
    expect(r1.pages).toBeGreaterThan(3); // history page size 2
    const count = async () => (await ctx.db.select().from(s.messages).where(eq(s.messages.direction, "inbound"))).length;
    expect(await count()).toBe(5);
    fake.minValidHistory = Number.MAX_SAFE_INTEGER; // every stored history id is now too old → 404
    const r2 = await syncMailbox(svc, ctx.mailbox.id);
    expect(r2.resyncs).toBeGreaterThan(0);
    fake.minValidHistory = 0;
    expect(await count()).toBe(5);
  });

  it("an expired or revoked Google token marks the mailbox expired and holds the send", async () => {
    const { fake, svc } = await gmailSetup();
    const { sd } = await scheduled(svc);
    fake.faults.push({ path: /^POST \/drafts$/, kind: "status", status: 401, reason: "authError" });
    await dispatchTick(svc);
    expect((await sendRow(ctx.db, sd.id)).state).toBe("held");
    const [mb] = await ctx.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, ctx.mailbox.id));
    expect(mb.status).toBe("expired");
  });
});
