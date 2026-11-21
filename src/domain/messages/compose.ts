/**
 * Outbound messages, immutable revisions and approvals.
 *
 * - Every edit to subject, body, recipients, mailbox or attachments creates a
 *   new revision (message_revisions is append-only at the DB level).
 * - An approval binds one revision's content hash + mailbox. Editing revokes
 *   it and supersedes any queued send of the older revision, so the old
 *   content can never be dispatched.
 * - Approval is blocked while placeholders are unresolved/unknown, recipients
 *   are invalid/suppressed/bounced, or attachments are missing.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import * as s from "@/db/schema";
import type { DbOrTx } from "@/db/client";
import { sha256Hex, stableStringify } from "@/lib/crypto";
import { normalizeEmail } from "../normalize";
import { htmlToText, sanitizeOutboundHtml, scanPlaceholders } from "../templates";
import { audit } from "../audit";
import { logTransition } from "../dispatch/states";
import type { Services } from "../services";

export interface AttachmentRef {
  documentVersionId: string;
  filename: string;
  sha256: string;
  size: number;
}

export interface RevisionContent {
  subject: string;
  bodyHtml: string;
  to: string[];
  cc: string[];
  mailboxId: string;
  attachmentVersionIds: string[];
}

export class ComposeError extends Error {
  constructor(message: string, public issues: string[] = []) {
    super(message);
  }
}

export function contentHashOf(c: { subject: string; bodyHtml: string; bodyText: string; to: string[]; cc: string[]; mailboxId: string; attachments: AttachmentRef[] }) {
  return sha256Hex(stableStringify({
    subject: c.subject,
    html: c.bodyHtml,
    text: c.bodyText,
    to: [...c.to].sort(),
    cc: [...c.cc].sort(),
    mailbox: c.mailboxId,
    attachments: c.attachments.map((a) => `${a.documentVersionId}:${a.sha256}`).sort(),
  }));
}

async function resolveAttachments(db: DbOrTx, ownerId: string, ids: string[]): Promise<AttachmentRef[]> {
  if (!ids.length) return [];
  const rows = await db.select({ v: s.documentVersions, d: s.documents }).from(s.documentVersions).innerJoin(s.documents, eq(s.documents.id, s.documentVersions.documentId)).where(and(inArray(s.documentVersions.id, ids), eq(s.documents.ownerId, ownerId)));
  if (rows.length !== new Set(ids).size) throw new ComposeError("One or more attachments were not found.");
  return ids.map((id) => {
    const r = rows.find((x) => x.v.id === id)!;
    return { documentVersionId: id, filename: r.v.filename, sha256: r.v.sha256, size: r.v.sizeBytes };
  });
}

function normalizeRecipients(list: string[]) {
  const out: string[] = [];
  const bad: string[] = [];
  for (const raw of list) {
    for (const part of raw.split(/[;,]/)) {
      if (!part.trim()) continue;
      const n = normalizeEmail(part);
      if (n) out.push(n);
      else bad.push(part.trim());
    }
  }
  return { out: [...new Set(out)], bad };
}

export async function createMessage(
  svc: Services,
  args: {
    ownerId: string;
    companyId: string | null;
    contactId: string | null;
    content: RevisionContent;
    kind?: string;
    enrollmentId?: string | null;
    campaignId?: string | null;
    replyToMessageId?: string | null;
    sequenceStep?: number;
    templateId?: string | null;
    createdBy?: string;
    isDemo?: boolean;
  },
) {
  return svc.db.transaction(async (tx) => {
    const [msg] = await tx.insert(s.messages).values({
      ownerId: args.ownerId,
      mailboxId: args.content.mailboxId,
      companyId: args.companyId,
      contactId: args.contactId,
      enrollmentId: args.enrollmentId ?? null,
      campaignId: args.campaignId ?? null,
      replyToMessageId: args.replyToMessageId ?? null,
      direction: "outbound",
      kind: args.kind ?? "initial",
      sequenceStep: args.sequenceStep ?? 0,
      status: "draft",
      evidenceSource: "app",
      isDemo: args.isDemo ?? false,
    }).returning();
    const rev = await insertRevision(tx, args.ownerId, msg.id, 1, args.content, args.templateId ?? null, args.createdBy ?? "user");
    await tx.update(s.messages).set({ currentRevisionId: rev.id, subject: rev.subject, toAddresses: rev.toAddresses, ccAddresses: rev.ccAddresses, bodyText: rev.bodyText }).where(eq(s.messages.id, msg.id));
    await logTransition(tx, { ownerId: args.ownerId, messageId: msg.id, from: null, to: "draft", actor: "user", reason: "created", at: svc.clock.now() });
    return { message: msg, revision: rev };
  });
}

async function prepareRevision(tx: DbOrTx, ownerId: string, c: RevisionContent) {
  const { out: to, bad: badTo } = normalizeRecipients(c.to);
  const { out: cc, bad: badCc } = normalizeRecipients(c.cc);
  if (badTo.length || badCc.length) throw new ComposeError("Invalid recipient address.", [...badTo, ...badCc].map((b) => `Invalid address: ${b}`));
  const subject = c.subject.trim();
  const bodyHtml = sanitizeOutboundHtml(c.bodyHtml);
  const bodyText = htmlToText(bodyHtml);
  const attachments = await resolveAttachments(tx, ownerId, c.attachmentVersionIds);
  const contentHash = contentHashOf({ subject, bodyHtml, bodyText, to, cc, mailboxId: c.mailboxId, attachments });
  return { mailboxId: c.mailboxId, subject, bodyHtml, bodyText, toAddresses: to, ccAddresses: cc, attachments, contentHash };
}

async function insertRevision(tx: DbOrTx, ownerId: string, messageId: string, revisionNo: number, c: RevisionContent, templateId: string | null, createdBy: string) {
  const p = await prepareRevision(tx, ownerId, c);
  const [rev] = await tx.insert(s.messageRevisions).values({ messageId, revisionNo, ...p, templateId, createdBy }).returning();
  return rev;
}

export interface ReviseResult {
  revision: typeof s.messageRevisions.$inferSelect;
  revokedApproval: boolean;
  supersededSends: number;
  unchanged: boolean;
}

/** Create a new revision. Revokes the approval and supersedes queued sends of older revisions. */
export async function reviseMessage(svc: Services, args: { ownerId: string; messageId: string; content: RevisionContent; createdBy?: string }): Promise<ReviseResult> {
  return svc.db.transaction(async (tx) => {
    const [msg] = await tx.select().from(s.messages).where(and(eq(s.messages.id, args.messageId), eq(s.messages.ownerId, args.ownerId)));
    if (!msg || msg.direction !== "outbound") throw new ComposeError("Message not found.");
    const blocking = await tx.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.messageId, msg.id), inArray(s.scheduledSends.state, ["dispatching", "submitted", "uncertain", "recorded_sent"])));
    if (blocking.length) throw new ComposeError(`This message is already ${blocking[0].state.replace("_", " ")}; it can no longer be edited. Create a follow-up instead.`);
    const [cur] = await tx.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, msg.currentRevisionId!));
    const candidate = await prepareRevision(tx, args.ownerId, args.content);
    if (candidate.contentHash === cur.contentHash) return { revision: cur, revokedApproval: false, supersededSends: 0, unchanged: true };
    const rev = await insertRevision(tx, args.ownerId, msg.id, cur.revisionNo + 1, args.content, cur.templateId, args.createdBy ?? "user");
    const now = svc.clock.now();
    const revoked = await tx.update(s.approvals).set({ revokedAt: now, revokeReason: `Superseded by revision ${rev.revisionNo}` }).where(and(eq(s.approvals.messageId, msg.id), isNull(s.approvals.revokedAt))).returning();
    let superseded = 0;
    const sends = await tx.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.messageId, msg.id), inArray(s.scheduledSends.state, ["scheduled", "held", "paused", "failed"])));
    for (const sd of sends) {
      // CAS on version: if a worker claimed it meanwhile, this update matches nothing.
      const upd = await tx.update(s.scheduledSends).set({ state: "superseded", holdReason: `Revision ${rev.revisionNo} replaced the approved content`, version: sd.version + 1, updatedAt: now }).where(and(eq(s.scheduledSends.id, sd.id), eq(s.scheduledSends.version, sd.version))).returning();
      if (!upd.length) throw new ComposeError("A worker claimed this message while you were editing; reload to see its state.");
      superseded++;
      await logTransition(tx, { ownerId: args.ownerId, scheduledSendId: sd.id, messageId: msg.id, from: sd.state, to: "superseded", actor: "user", reason: `edited → revision ${rev.revisionNo}`, at: now });
    }
    await tx.update(s.messages).set({ currentRevisionId: rev.id, status: "draft", mailboxId: rev.mailboxId, subject: rev.subject, toAddresses: rev.toAddresses, ccAddresses: rev.ccAddresses, bodyText: rev.bodyText, updatedAt: now }).where(eq(s.messages.id, msg.id));
    await audit(tx, { ownerId: args.ownerId, entityType: "message", entityId: msg.id, action: "revise", before: { revision: cur.revisionNo, hash: cur.contentHash }, after: { revision: rev.revisionNo, hash: rev.contentHash } });
    return { revision: rev, revokedApproval: revoked.length > 0, supersededSends: superseded, unchanged: false };
  });
}

export interface EligibilityIssue {
  code: string;
  message: string;
}

/** Checks that block approval (and are rechecked at dispatch). Plain-language messages for the UI. */
export async function approvalBlockers(db: DbOrTx, ownerId: string, rev: typeof s.messageRevisions.$inferSelect): Promise<EligibilityIssue[]> {
  const issues: EligibilityIssue[] = [];
  for (const p of scanPlaceholders(rev.subject + " " + rev.bodyHtml)) issues.push({ code: "placeholder", message: `Unresolved placeholder {{${p.name}}} — fill it in or edit the text.` });
  const to = rev.toAddresses as string[];
  if (!to.length) issues.push({ code: "no_recipient", message: "No recipient address." });
  if (!rev.subject.trim()) issues.push({ code: "no_subject", message: "Subject is empty." });
  if (!rev.mailboxId) issues.push({ code: "no_mailbox", message: "Choose a sending mailbox." });
  const all = [...to, ...(rev.ccAddresses as string[])];
  if (all.length) {
    const emails = await db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.ownerId, ownerId), inArray(s.emailAddresses.normalized, all)));
    for (const e of emails) {
      if (e.suppressed) issues.push({ code: "suppressed", message: `${e.address} is suppressed (do not contact).` });
      if (e.bounceState === "hard") issues.push({ code: "bounced", message: `${e.address} previously hard-bounced.` });
      if (e.quality === "invalid") issues.push({ code: "invalid", message: `${e.address} is marked invalid.` });
      if (e.source === "ai_guess" && e.quality === "unknown") issues.push({ code: "ai_guess", message: `${e.address} was guessed by AI and is unverified; confirm it before approving.` });
    }
    const supp = await db.select().from(s.suppressions).where(and(eq(s.suppressions.ownerId, ownerId), inArray(s.suppressions.value, [...all, ...all.map((a) => a.split("@")[1])])));
    for (const sp of supp) issues.push({ code: "suppressed", message: `Suppressed (${sp.scope}): ${sp.value} — ${sp.reason}` });
  }
  return issues;
}

export async function approveCurrentRevision(svc: Services, args: { ownerId: string; messageId: string; via?: "review" | "send_now" | "batch" }) {
  return svc.db.transaction(async (tx) => {
    const [msg] = await tx.select().from(s.messages).where(and(eq(s.messages.id, args.messageId), eq(s.messages.ownerId, args.ownerId)));
    if (!msg) throw new ComposeError("Message not found.");
    const [rev] = await tx.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, msg.currentRevisionId!));
    const issues = await approvalBlockers(tx, args.ownerId, rev);
    if (msg.companyId) {
      const [co] = await tx.select().from(s.companies).where(eq(s.companies.id, msg.companyId));
      if (co?.suppressed) issues.push({ code: "company_suppressed", message: `${co.name} is suppressed: ${co.suppressedReason ?? "do not contact"}.` });
    }
    if (issues.length) throw new ComposeError("This revision cannot be approved yet.", issues.map((i) => i.message));
    const existing = await tx.select().from(s.approvals).where(and(eq(s.approvals.messageId, msg.id), eq(s.approvals.revisionId, rev.id), isNull(s.approvals.revokedAt)));
    if (existing.length) return existing[0];
    const [ap] = await tx.insert(s.approvals).values({ messageId: msg.id, revisionId: rev.id, contentHash: rev.contentHash, mailboxId: rev.mailboxId!, approvedVia: args.via ?? "review", approvedAt: svc.clock.now() }).returning();
    await tx.update(s.messages).set({ status: "approved", updatedAt: svc.clock.now() }).where(eq(s.messages.id, msg.id));
    await logTransition(tx, { ownerId: args.ownerId, messageId: msg.id, from: msg.status, to: "approved", actor: "user", reason: `approved revision ${rev.revisionNo} (${args.via ?? "review"})`, at: svc.clock.now() });
    return ap;
  });
}

/** The active approval valid for the message's current revision, or null. */
export async function currentApproval(db: DbOrTx, messageId: string) {
  const [msg] = await db.select().from(s.messages).where(eq(s.messages.id, messageId));
  if (!msg?.currentRevisionId) return null;
  const [rev] = await db.select().from(s.messageRevisions).where(eq(s.messageRevisions.id, msg.currentRevisionId));
  const aps = await db.select().from(s.approvals).where(and(eq(s.approvals.messageId, messageId), isNull(s.approvals.revokedAt))).orderBy(desc(s.approvals.approvedAt));
  const ap = aps.find((a) => a.revisionId === rev.id && a.contentHash === rev.contentHash);
  return ap ? { approval: ap, revision: rev, message: msg } : null;
}
