"use server";
import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/server/auth";
import { getServices } from "@/server/runtime";
import { back, errMessage } from "@/server/flash";
import * as s from "@/db/schema";
import { reassignConversation, setReplyCategory } from "@/domain/mail/sync";
import { createMessage } from "@/domain/messages/compose";
import { aiClassifyReply, aiSummarizeConversation } from "@/domain/ai/assist";
import { enqueueJob } from "@/domain/jobs";
import { pauseFollowupsFor } from "@/domain/outreach/sequences";

export async function setCategoryAction(fd: FormData) {
  const o = await requireOwner();
  const conv = String(fd.get("conversationId"));
  const category = String(fd.get("category"));
  const svc = getServices();
  await setReplyCategory(svc, o.id, String(fd.get("messageId")), category);
  if (category === "unsubscribe") {
    const [m] = await svc.db.select().from(s.messages).where(eq(s.messages.id, String(fd.get("messageId"))));
    if (m?.fromAddress) await svc.db.insert(s.suppressions).values({ ownerId: o.id, scope: "address", value: m.fromAddress.toLowerCase(), reason: "Asked not to be contacted (confirmed manually)" }).onConflictDoNothing();
    await pauseFollowupsFor(svc, { ownerId: o.id, companyId: m?.companyId ?? null, contactId: m?.contactId ?? null, reason: "Do not contact", scope: "contact" });
  }
  back(`/inbox/${conv}`, { msg: "Category set manually (manual choices are never overwritten by rules or AI)." });
}

export async function reassignAction(fd: FormData) {
  const o = await requireOwner();
  const conv = String(fd.get("conversationId"));
  const companyId = String(fd.get("companyId") ?? "") || null;
  const contactId = String(fd.get("contactId") ?? "") || null;
  await reassignConversation(getServices(), o.id, conv, companyId, contactId);
  back(`/inbox/${conv}`, { msg: "Conversation assigned manually." });
}

export async function markReadAction(fd: FormData) {
  const o = await requireOwner();
  const conv = String(fd.get("conversationId"));
  const db = getServices().db;
  await db.update(s.messages).set({ isRead: true }).where(and(eq(s.messages.conversationId, conv), eq(s.messages.ownerId, o.id)));
  await db.update(s.conversations).set({ unreadCount: 0 }).where(and(eq(s.conversations.id, conv), eq(s.conversations.ownerId, o.id)));
  back(`/inbox/${conv}`);
}

export async function replyDraftAction(fd: FormData) {
  const o = await requireOwner();
  const conv = String(fd.get("conversationId"));
  const parentId = String(fd.get("messageId"));
  const svc = getServices();
  let id = "";
  try {
    const [p] = await svc.db.select().from(s.messages).where(and(eq(s.messages.id, parentId), eq(s.messages.ownerId, o.id)));
    if (!p?.mailboxId) throw new Error("This message has no mailbox.");
    const subject = /^re:/i.test(p.subject ?? "") ? p.subject! : `Re: ${p.subject ?? ""}`;
    const to = p.direction === "inbound" ? [p.fromAddress ?? ""] : (p.toAddresses as string[]);
    const { message } = await createMessage(svc, { ownerId: o.id, companyId: p.companyId, contactId: p.contactId, kind: "reply", replyToMessageId: p.id, content: { subject, bodyHtml: "<p></p>", to, cc: [], mailboxId: p.mailboxId, attachmentVersionIds: [] } });
    await svc.db.update(s.messages).set({ conversationId: conv }).where(eq(s.messages.id, message.id));
    id = message.id;
  } catch (e) {
    back(`/inbox/${conv}`, { err: errMessage(e) });
  }
  back(`/drafts/${id}`, { msg: "Reply draft created. It will be sent in the same email thread after your approval." });
}

export async function aiSummaryAction(fd: FormData) {
  const o = await requireOwner();
  const conv = String(fd.get("conversationId"));
  try {
    const r = await aiSummarizeConversation(getServices(), o.id, conv);
    back(`/inbox/${conv}`, { msg: `AI suggestion — next action: ${r.nextAction}` });
  } catch (e) {
    back(`/inbox/${conv}`, { err: errMessage(e) });
  }
}

export async function aiClassifyAction(fd: FormData) {
  const o = await requireOwner();
  const conv = String(fd.get("conversationId"));
  try {
    const r = await aiClassifyReply(getServices(), o.id, String(fd.get("messageId")));
    back(`/inbox/${conv}`, { msg: `AI suggests: ${r.category} (${Math.round(r.confidence * 100)}%). ${r.rationale}` });
  } catch (e) {
    back(`/inbox/${conv}`, { err: errMessage(e) });
  }
}

export async function syncNowAction(fd: FormData) {
  const o = await requireOwner();
  const db = getServices().db;
  const mbs = await db.select().from(s.mailboxes).where(and(eq(s.mailboxes.ownerId, o.id), eq(s.mailboxes.status, "connected")));
  for (const m of mbs) await enqueueJob(db, { ownerId: o.id, kind: "mailbox_sync", payload: { mailboxId: m.id }, dedupeKey: `sync:${m.id}:pending` });
  back(String(fd.get("back") ?? "/inbox"), { msg: mbs.length ? `Sync requested for ${mbs.length} mailbox(es); the worker runs it within seconds.` : "No connected mailbox." });
}
