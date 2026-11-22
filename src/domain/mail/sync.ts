/**
 * Mailbox synchronisation and reply ingestion (see docs/SYNC.md).
 *
 * - Per-folder delta with persisted cursors; nextLink pages are followed and the
 *   deltaLink is saved only after a round completes, so a crash replays the
 *   round (duplicates are deduplicated by (mailbox, provider message id)).
 * - Expired cursors trigger a bounded resync from `initialSyncDays` ago.
 * - Initial sync scope is limited (default 90 days) — the whole mailbox is not
 *   fetched. Unrelated mail (no thread/address/domain link) is NOT stored.
 * - Thread matching is deterministic: reply headers / our internet message id →
 *   provider conversation id → exact sender address. Domain-only matches go to a
 *   review queue and are never merged automatically.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { errorSummary } from "@/lib/redact";
import { normalizeEmail, registrableDomain } from "../normalize";
import { sanitizeInboundHtml, htmlToText } from "../templates";
import { classifyInbound, CATEGORY_LABEL } from "./classify";
import { getMailAccess, handleAuthError } from "./access";
import { pauseFollowupsFor } from "../outreach/sequences";
import { logTransition } from "../dispatch/states";
import { classifyOverdue } from "../scheduling/time";
import { MailProviderError, type SyncedMessage } from "@/providers/mail/types";
import type { Services } from "../services";

export interface SyncReport {
  folders: number;
  pages: number;
  ingested: number;
  duplicates: number;
  skippedUnrelated: number;
  resyncs: number;
  errors: string[];
}

export async function ensureFolders(svc: Services, mailboxId: string) {
  const { provider, ctx } = await getMailAccess(svc, mailboxId);
  const folders = await provider.listFolders(ctx);
  for (const f of folders) {
    const tracked = f.role === "inbox" || f.role === "sentitems";
    await svc.db.insert(s.mailboxFolders).values({ mailboxId, providerFolderId: f.id, displayName: f.displayName, role: f.role, tracked, messageCount: f.totalCount })
      .onConflictDoUpdate({ target: [s.mailboxFolders.mailboxId, s.mailboxFolders.providerFolderId], set: { displayName: f.displayName, role: f.role, messageCount: f.totalCount } });
  }
  return folders;
}

export async function syncMailbox(svc: Services, mailboxId: string, opts: { folderIds?: string[] } = {}): Promise<SyncReport> {
  const report: SyncReport = { folders: 0, pages: 0, ingested: 0, duplicates: 0, skippedUnrelated: 0, resyncs: 0, errors: [] };
  let access;
  try {
    access = await getMailAccess(svc, mailboxId);
  } catch (e) {
    report.errors.push(errorSummary(e));
    return report;
  }
  const { mailbox, provider, ctx } = access;
  let folders = await svc.db.select().from(s.mailboxFolders).where(and(eq(s.mailboxFolders.mailboxId, mailboxId), eq(s.mailboxFolders.tracked, true)));
  if (!folders.length) {
    await ensureFolders(svc, mailboxId);
    folders = await svc.db.select().from(s.mailboxFolders).where(and(eq(s.mailboxFolders.mailboxId, mailboxId), eq(s.mailboxFolders.tracked, true)));
  }
  if (opts.folderIds) folders = folders.filter((f) => opts.folderIds!.includes(f.id) || opts.folderIds!.includes(f.providerFolderId));
  const initialSince = new Date(svc.clock.now().getTime() - mailbox.initialSyncDays * 86400_000);
  let allOk = true;
  for (const folder of folders) {
    report.folders++;
    let link: string | null = folder.deltaLink;
    let finalDelta: string | null = null;
    try {
      for (let guard = 0; guard < 500; guard++) {
        let page;
        try {
          page = await provider.deltaPage(ctx, folder.providerFolderId, link, { initialSince });
        } catch (e) {
          if (e instanceof MailProviderError && e.kind === "delta_expired" && link) {
            report.resyncs++;
            link = null; // bounded resync from initialSince; ingest dedupes
            continue;
          }
          throw e;
        }
        report.pages++;
        for (const m of page.messages) {
          const r = await ingestMessage(svc, mailbox, folder.role, m);
          if (r === "duplicate") report.duplicates++;
          else if (r === "unrelated") report.skippedUnrelated++;
          else report.ingested++;
        }
        for (const id of page.removedIds) {
          // Moved/deleted in provider: keep our record (history), clear folder.
          await svc.db.update(s.messages).set({ providerFolderId: null }).where(and(eq(s.messages.mailboxId, mailboxId), eq(s.messages.providerMessageId, id), eq(s.messages.providerFolderId, folder.providerFolderId)));
        }
        if (page.nextLink) {
          link = page.nextLink;
          continue;
        }
        finalDelta = page.deltaLink;
        break;
      }
      await svc.db.update(s.mailboxFolders).set({ deltaLink: finalDelta ?? folder.deltaLink, lastSyncedAt: svc.clock.now(), lastError: null }).where(eq(s.mailboxFolders.id, folder.id));
    } catch (e) {
      allOk = false;
      report.errors.push(`${folder.displayName}: ${errorSummary(e)}`);
      await handleAuthError(svc, mailboxId, e);
      await svc.db.update(s.mailboxFolders).set({ lastError: errorSummary(e) }).where(eq(s.mailboxFolders.id, folder.id));
    }
  }
  const now = svc.clock.now();
  if (allOk) {
    await svc.db.update(s.mailboxes).set({ lastSyncAt: now, lastSyncError: null }).where(eq(s.mailboxes.id, mailboxId));
    // Follow-ups held only because sync was stale are re-evaluated by the dispatcher.
    const held = await svc.db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.mailboxId, mailboxId), eq(s.scheduledSends.state, "held"), eq(s.scheduledSends.lastError, "sync_stale")));
    const [st] = held.length ? await svc.db.select().from(s.settings).where(eq(s.settings.ownerId, mailbox.ownerId)) : [];
    for (const h of held) {
      // A hold that outlived the missed-send grace window needs review, not an automatic late send.
      if (classifyOverdue(h.plannedAt, now, st.missedSendGraceMinutes) === "stale_overdue") {
        const reason = `Follow-up was held for a stale mailbox sync until its planned time was more than ${st.missedSendGraceMinutes} minutes past. Sync is fresh now — review and release or reschedule.`;
        const [u] = await svc.db.update(s.scheduledSends).set({ holdReason: reason, lastError: null, version: h.version + 1 }).where(and(eq(s.scheduledSends.id, h.id), eq(s.scheduledSends.version, h.version))).returning();
        if (u) await logTransition(svc.db, { ownerId: h.ownerId, scheduledSendId: h.id, messageId: h.messageId, from: "held", to: "held", actor: "system", reason: "sync fresh, but planned time is stale — kept for review", at: now });
        continue;
      }
      const [u] = await svc.db.update(s.scheduledSends).set({ state: "scheduled", holdReason: null, lastError: null, nextAttemptAt: now, version: h.version + 1 }).where(and(eq(s.scheduledSends.id, h.id), eq(s.scheduledSends.version, h.version))).returning();
      if (u) await logTransition(svc.db, { ownerId: h.ownerId, scheduledSendId: h.id, messageId: h.messageId, from: "held", to: "scheduled", actor: "system", reason: "mailbox synced; follow-up eligibility will be re-evaluated before dispatch", at: now });
    }
  } else await svc.db.update(s.mailboxes).set({ lastSyncError: report.errors.join("; ").slice(0, 500) }).where(eq(s.mailboxes.id, mailboxId));
  return report;
}

type Mailbox = typeof s.mailboxes.$inferSelect;

export async function ingestMessage(svc: Services, mailbox: Mailbox, folderRole: string, m: SyncedMessage): Promise<"new" | "updated" | "duplicate" | "unrelated"> {
  const db = svc.db;
  const [existing] = await db.select().from(s.messages).where(and(eq(s.messages.mailboxId, mailbox.id), eq(s.messages.providerMessageId, m.providerMessageId)));
  if (existing) {
    if (existing.isRead !== m.isRead || existing.providerFolderId !== m.folderId) {
      await db.update(s.messages).set({ isRead: m.isRead, providerFolderId: m.folderId }).where(eq(s.messages.id, existing.id));
      return "updated";
    }
    return "duplicate";
  }
  if (m.isDraft) return "unrelated";
  const me = (mailbox.emailAddress ?? "").toLowerCase();
  const outbound = folderRole === "sentitems" || (m.from ?? "").toLowerCase() === me;

  if (outbound) {
    // Our own app message (immutable ID of the draft or internet message id)?
    let [ours] = await db.select().from(s.messages).where(and(eq(s.messages.mailboxId, mailbox.id), eq(s.messages.direction, "outbound"), sql`(${s.messages.providerDraftId} = ${m.providerMessageId} OR ${s.messages.providerMessageId} = ${m.providerMessageId} OR (${s.messages.internetMessageId} IS NOT NULL AND ${s.messages.internetMessageId} = ${m.internetMessageId}))`));
    // Providers where sending creates a new message id (Gmail): match our just-submitted message in the same thread.
    if (!ours && m.conversationId) {
      const pending = await db.select().from(s.messages).where(and(eq(s.messages.mailboxId, mailbox.id), eq(s.messages.direction, "outbound"), eq(s.messages.providerConversationId, m.conversationId), sql`${s.messages.providerMessageId} IS NULL`, inArray(s.messages.status, ["dispatching", "submitted", "uncertain"])));
      if (pending.length === 1) ours = pending[0];
    }
    if (ours) {
      await db.update(s.messages).set({ providerMessageId: m.providerMessageId, providerFolderId: m.folderId, providerConversationId: m.conversationId ?? ours.providerConversationId, recordedSentAt: ours.recordedSentAt ?? m.sentAt, webLink: m.webLink ?? ours.webLink }).where(eq(s.messages.id, ours.id));
      // A sync observation also reconciles submitted/uncertain sends.
      const sends = await db.select().from(s.scheduledSends).where(and(eq(s.scheduledSends.messageId, ours.id), inArray(s.scheduledSends.state, ["submitted", "uncertain"])));
      for (const sd of sends) {
        const [u] = await db.update(s.scheduledSends).set({ state: "recorded_sent", recordedSentAt: m.sentAt ?? svc.clock.now(), resolutionRequired: false, version: sd.version + 1 }).where(and(eq(s.scheduledSends.id, sd.id), eq(s.scheduledSends.version, sd.version))).returning();
        if (u) {
          await db.update(s.messages).set({ status: "recorded_sent" }).where(eq(s.messages.id, ours.id));
          await logTransition(db, { ownerId: sd.ownerId, scheduledSendId: sd.id, messageId: ours.id, from: sd.state, to: "recorded_sent", actor: "system", reason: "sent copy observed during mailbox sync", at: svc.clock.now() });
        }
      }
      await ensureConversation(svc, mailbox, ours.id, m.conversationId, ours.companyId, ours.contactId, m.subject, m.sentAt, "matched", "own message");
      return "updated";
    }
    // Sent outside the app: link only if a recipient is a known address.
    const link = await matchByAddresses(svc, mailbox.ownerId, m.to);
    if (!link) return "unrelated";
    const [row] = await db.insert(s.messages).values({
      ownerId: mailbox.ownerId, mailboxId: mailbox.id, companyId: link.companyId, contactId: link.contactId, direction: "outbound", kind: "external_sent", status: "recorded_sent",
      providerMessageId: m.providerMessageId, internetMessageId: m.internetMessageId, providerConversationId: m.conversationId, providerFolderId: m.folderId,
      fromAddress: m.from, toAddresses: m.to, ccAddresses: m.cc, subject: m.subject, bodyText: m.bodyText.slice(0, 20000), recordedSentAt: m.sentAt, webLink: m.webLink,
      evidenceSource: "external_outlook", isDemo: mailbox.isDemo,
    }).returning();
    await ensureConversation(svc, mailbox, row.id, m.conversationId, link.companyId, link.contactId, m.subject, m.sentAt, "matched", "recipient address matches a known contact");
    return "new";
  }

  // ── Inbound ──
  const cls = classifyInbound({ from: m.from, subject: m.subject, bodyText: m.bodyText || htmlToText(m.bodyHtml ?? ""), headers: m.headers });
  let parent: typeof s.messages.$inferSelect | undefined;
  const refs = [m.inReplyTo, ...(m.references ?? "").split(/\s+/)].filter(Boolean) as string[];
  if (refs.length) [parent] = await db.select().from(s.messages).where(and(eq(s.messages.ownerId, mailbox.ownerId), inArray(s.messages.internetMessageId, refs)));
  let matchReason = parent ? "reply headers reference our message" : "";
  if (!parent && m.conversationId) {
    [parent] = await db.select().from(s.messages).where(and(eq(s.messages.mailboxId, mailbox.id), eq(s.messages.providerConversationId, m.conversationId), eq(s.messages.direction, "outbound")));
    if (parent) matchReason = "same provider conversation as our message";
  }
  let companyId = parent?.companyId ?? null;
  let contactId = parent?.contactId ?? null;
  let matchStatus: "matched" | "ambiguous" = "matched";

  // Bounces reference the original recipient; link via the failed address.
  let bounced: string | null = null;
  if (cls.isBounce) {
    const candidates = [...new Set((m.bodyText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((x) => x.toLowerCase()))].filter((x) => x !== me);
    const known = candidates.length ? await db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.ownerId, mailbox.ownerId), inArray(s.emailAddresses.normalized, candidates))) : [];
    bounced = known[0]?.normalized ?? cls.bouncedAddress;
    if (known[0]) {
      companyId ??= known[0].companyId;
      contactId ??= known[0].contactId;
      matchReason ||= "bounce notice names a known address";
    }
  }
  if (!parent && !companyId) {
    const from = normalizeEmail(m.from);
    const byAddr = from ? await matchByAddresses(svc, mailbox.ownerId, [from]) : null;
    if (byAddr) {
      companyId = byAddr.companyId;
      contactId = byAddr.contactId;
      matchReason = "sender address matches a known contact";
    } else if (from) {
      const dom = registrableDomain(from.split("@")[1]);
      const cos = dom ? await db.select({ id: s.companies.id, name: s.companies.name }).from(s.companies).where(and(eq(s.companies.ownerId, mailbox.ownerId), sql`(${s.companies.domain} = ${dom} OR ${s.companies.domain} LIKE ${"%." + dom})`)) : [];
      if (!cos.length) return "unrelated";
      // Domain alone is not enough to merge: keep for review.
      companyId = cos.length === 1 ? cos[0].id : null;
      matchStatus = "ambiguous";
      matchReason = cos.length === 1 ? `sender domain matches ${cos[0].name}, but the sender is not a known contact` : `sender domain matches ${cos.length} companies`;
    }
  }
  if (!parent && !companyId && matchStatus !== "ambiguous") return "unrelated";

  const [row] = await db.insert(s.messages).values({
    ownerId: mailbox.ownerId, mailboxId: mailbox.id, companyId, contactId, direction: "inbound", kind: "inbound", status: "received",
    replyToMessageId: parent?.id ?? null,
    providerMessageId: m.providerMessageId, internetMessageId: m.internetMessageId, providerConversationId: m.conversationId, inReplyTo: m.inReplyTo, referencesHeader: m.references,
    providerFolderId: m.folderId, webLink: m.webLink, fromAddress: m.from, toAddresses: m.to, ccAddresses: m.cc, subject: m.subject,
    bodyText: (m.bodyText || htmlToText(m.bodyHtml ?? "")).slice(0, 50000), bodyHtmlSanitized: m.bodyHtml ? sanitizeInboundHtml(m.bodyHtml).slice(0, 200000) : null,
    hasAttachments: m.hasAttachments, isRead: m.isRead, receivedAt: m.receivedAt, evidenceSource: "provider_sync",
    category: cls.category, categorySource: "rule", categoryConfidence: cls.confidence, isAutomated: cls.isAutomated, isBounce: cls.isBounce, bouncedAddress: bounced,
    needsReview: matchStatus === "ambiguous" || cls.category === "uncertain", reviewReason: matchStatus === "ambiguous" ? matchReason : cls.category === "uncertain" ? "Reply category uncertain" : null,
    isDemo: mailbox.isDemo,
  }).returning();
  const conv = await ensureConversation(svc, mailbox, row.id, m.conversationId, companyId, contactId, m.subject, m.receivedAt, matchStatus, matchReason, parent?.conversationId ?? null);
  // The original outbound message joins the thread if it was not yet linked.
  if (parent && !parent.conversationId) await db.update(s.messages).set({ conversationId: conv.id }).where(eq(s.messages.id, parent.id));
  await applyInboundEffects(svc, row, cls.category, bounced);
  return "new";
}

async function matchByAddresses(svc: Services, ownerId: string, addrs: string[]) {
  const norm = addrs.map((a) => normalizeEmail(a)).filter(Boolean) as string[];
  if (!norm.length) return null;
  const [e] = await svc.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.ownerId, ownerId), inArray(s.emailAddresses.normalized, norm)));
  return e ? { companyId: e.companyId, contactId: e.contactId } : null;
}

async function ensureConversation(svc: Services, mailbox: Mailbox, messageId: string, providerConversationId: string | null, companyId: string | null, contactId: string | null, subject: string | null, at: Date | null, matchStatus: string, reason: string, knownConversationId: string | null = null) {
  const db = svc.db;
  let conv: typeof s.conversations.$inferSelect | undefined;
  if (knownConversationId) [conv] = await db.select().from(s.conversations).where(eq(s.conversations.id, knownConversationId));
  if (!conv && providerConversationId) [conv] = await db.select().from(s.conversations).where(and(eq(s.conversations.mailboxId, mailbox.id), eq(s.conversations.providerConversationId, providerConversationId)));
  const [msg] = await db.select().from(s.messages).where(eq(s.messages.id, messageId));
  if (!conv && msg.conversationId) [conv] = await db.select().from(s.conversations).where(eq(s.conversations.id, msg.conversationId));
  if (!conv) {
    [conv] = await db.insert(s.conversations).values({ ownerId: mailbox.ownerId, mailboxId: mailbox.id, companyId, contactId, providerConversationId, subject, lastMessageAt: at, matchStatus, matchReason: reason, isDemo: mailbox.isDemo }).returning();
  } else {
    const set: Partial<typeof s.conversations.$inferInsert> = { lastMessageAt: at && (!conv.lastMessageAt || at > conv.lastMessageAt) ? at : conv.lastMessageAt };
    if (!conv.providerConversationId && providerConversationId) set.providerConversationId = providerConversationId;
    if (conv.matchStatus !== "manual" && matchStatus === "ambiguous" && conv.matchStatus === "matched") set.matchReason = `${conv.matchReason ?? ""}; later message only matched by domain`;
    await db.update(s.conversations).set(set).where(eq(s.conversations.id, conv.id));
  }
  await db.update(s.messages).set({ conversationId: conv.id }).where(eq(s.messages.id, messageId));
  if (msg.direction === "inbound" && !msg.isRead) await db.update(s.conversations).set({ unreadCount: sql`${s.conversations.unreadCount} + 1` }).where(eq(s.conversations.id, conv.id));
  return conv;
}

/** Side effects of an inbound message, per the documented coordination policy. */
async function applyInboundEffects(svc: Services, msg: typeof s.messages.$inferSelect, category: string, bounced: string | null) {
  const db = svc.db;
  const now = svc.clock.now();
  const [st] = await db.select().from(s.settings).where(eq(s.settings.ownerId, msg.ownerId));
  const scope = st.companyCoordinationPolicy === "pause_company" ? "company" : "contact";
  const [co] = msg.companyId ? await db.select().from(s.companies).where(eq(s.companies.id, msg.companyId)) : [];
  const who = co?.name ?? msg.fromAddress ?? "unknown sender";

  if (category === "bounce" && bounced) {
    await db.update(s.emailAddresses).set({ bounceState: "hard", bouncedAt: now }).where(and(eq(s.emailAddresses.ownerId, msg.ownerId), eq(s.emailAddresses.normalized, bounced)));
    // Mark the original outbound message(s) as bounced — outreach history is kept.
    await db.update(s.messages).set({ isBounce: true, bouncedAddress: bounced }).where(and(eq(s.messages.ownerId, msg.ownerId), eq(s.messages.direction, "outbound"), sql`${s.messages.toAddresses} @> ${JSON.stringify([bounced])}::jsonb`));
    await pauseFollowupsFor(svc, { ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, reason: `Bounce for ${bounced}`, scope: "contact" });
    if (msg.companyId) await db.insert(s.tasks).values({ ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, messageId: msg.id, kind: "replacement_contact", title: `${bounced} bounced — research a replacement contact at ${who}`, dueAt: now, isDemo: msg.isDemo });
    return;
  }
  if (!msg.companyId && !msg.contactId) return;
  if (category === "automated_ack") return; // acknowledgement: no follow-up change

  if (category === "out_of_office") {
    await pauseFollowupsFor(svc, { ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, reason: "Out-of-office reply — choose a new date (not auto-extended)", scope: "contact" });
    await db.insert(s.tasks).values({ ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, messageId: msg.id, kind: "reply", title: `Out-of-office from ${who}: pick a new follow-up date`, dueAt: now, isDemo: msg.isDemo });
    return;
  }
  // Human reply (any category incl. uncertain): stop automated follow-up pending review.
  await pauseFollowupsFor(svc, { ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, reason: `Reply received (${CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL] ?? category}) — review before any further outreach`, scope });
  if (msg.contactId) await db.update(s.enrollments).set({ state: "stopped", stopReason: `reply: ${category}`, updatedAt: now }).where(and(eq(s.enrollments.contactId, msg.contactId), inArray(s.enrollments.state, ["active", "paused"])));
  if (category === "unsubscribe") {
    if (msg.fromAddress) {
      const addr = normalizeEmail(msg.fromAddress);
      if (addr) {
        await db.insert(s.suppressions).values({ ownerId: msg.ownerId, scope: "address", value: addr, reason: "Recipient asked not to be contacted (rule suggestion — review)" }).onConflictDoNothing();
        await db.update(s.emailAddresses).set({ suppressed: true }).where(and(eq(s.emailAddresses.ownerId, msg.ownerId), eq(s.emailAddresses.normalized, addr)));
      }
    }
    if (msg.contactId) await db.update(s.contacts).set({ suppressed: true }).where(eq(s.contacts.id, msg.contactId));
  }
  await db.insert(s.tasks).values({ ownerId: msg.ownerId, companyId: msg.companyId, contactId: msg.contactId, messageId: msg.id, kind: "reply", title: `Reply from ${who} (${CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL] ?? category}) — decide next step`, dueAt: now, isDemo: msg.isDemo });
}

/** Manual reassignment of an ambiguous conversation (never automatic). */
export async function reassignConversation(svc: Services, ownerId: string, conversationId: string, companyId: string | null, contactId: string | null) {
  await svc.db.update(s.conversations).set({ companyId, contactId, matchStatus: "manual", matchReason: "assigned manually" }).where(and(eq(s.conversations.id, conversationId), eq(s.conversations.ownerId, ownerId)));
  await svc.db.update(s.messages).set({ companyId, contactId, needsReview: false }).where(and(eq(s.messages.conversationId, conversationId), eq(s.messages.ownerId, ownerId)));
}

export async function setReplyCategory(svc: Services, ownerId: string, messageId: string, category: string) {
  await svc.db.update(s.messages).set({ category, categorySource: "manual", categoryConfidence: 1, needsReview: false }).where(and(eq(s.messages.id, messageId), eq(s.messages.ownerId, ownerId)));
}
