/**
 * Gmail API adapter (OAuth, owner's own @gmail.com mailbox). Verified against
 * Google's Gmail API docs (see docs/GMAIL.md):
 *  - Drafts: POST /drafts with a base64url RFC 2822 message. Updating a draft
 *    replaces its underlying message, so the draft's message id is a reliable
 *    fingerprint: a different id means the draft was edited in Gmail.
 *  - drafts.send deletes the draft and creates a NEW message (new id) with the
 *    SENT label in the same thread. The sent copy is therefore found via the
 *    thread (threadId) and the time the send could have happened.
 *  - Replies stay in a thread with threadId + matching Subject + RFC 2822
 *    In-Reply-To/References headers.
 *  - Sync: messages.list for the initial window, then history.list from a
 *    stored historyId; a 404 means the history expired → full resync.
 * Labels play the role of folders (INBOX, SENT, user labels).
 */
import {
  MailProviderError, type DeltaPage, type DraftInput, type DraftRef, type MailContext, type MailFolder, type MailProvider,
  type MailboxIdentity, type ProviderDraftState, type SendHint, type SentCopy, type SyncedMessage,
} from "./types";
import crypto from "node:crypto";

export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
type Fetch = typeof fetch;

// ───────────────────────── MIME ─────────────────────────
function b64url(data: Buffer | string) {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** RFC 2047 encoded-word for non-ASCII header values. */
function encodeHeader(v: string) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(v) ? v.replace(/[\r\n]+/g, " ") : `=?UTF-8?B?${Buffer.from(v.replace(/[\r\n]+/g, " ")).toString("base64")}?=`;
}

function wrap76(b64: string) {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

export interface MimeInput {
  from?: string | null;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; contentType: string; bytes: Uint8Array }[];
  inReplyTo?: string | null;
  references?: string | null;
}

export function buildMime(m: MimeInput, boundarySeed = crypto.randomBytes(12).toString("hex")): string {
  const mixed = `mixed_${boundarySeed}`;
  const alt = `alt_${boundarySeed}`;
  const headers = [
    ...(m.from ? [`From: ${m.from}`] : []),
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const parts: string[] = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(m.text, "utf8").toString("base64")),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(m.html, "utf8").toString("base64")),
    `--${alt}--`,
  ];
  for (const a of m.attachments) {
    const safe = a.filename.replace(/["\\\r\n]/g, "_");
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${safe}"`,
      `Content-Disposition: attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(Buffer.from(a.bytes).toString("base64")),
    );
  }
  parts.push(`--${mixed}--`, "");
  return [...headers, "", ...parts].join("\r\n");
}

// ───────────────────────── parsing ─────────────────────────
interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GPart;
}

const ADDR_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
function addresses(v: string | undefined) {
  return [...new Set((v ?? "").match(ADDR_RE)?.map((x) => x.toLowerCase()) ?? [])];
}

export function parseGmailMessage(m: GMessage, folderId: string): SyncedMessage {
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  let text = "";
  let html: string | null = null;
  let hasAttachments = false;
  const walk = (p?: GPart) => {
    if (!p) return;
    if (p.filename) {
      hasAttachments = true;
      return;
    }
    if (p.mimeType === "text/plain" && p.body?.data && !text) text = fromB64url(p.body.data).toString("utf8");
    else if (p.mimeType === "text/html" && p.body?.data && html == null) html = fromB64url(p.body.data).toString("utf8");
    for (const c of p.parts ?? []) walk(c);
  };
  walk(m.payload);
  const labels = new Set(m.labelIds ?? []);
  const at = m.internalDate ? new Date(Number(m.internalDate)) : null;
  const sent = labels.has("SENT");
  return {
    providerMessageId: m.id,
    internetMessageId: headers["message-id"] ?? null,
    conversationId: m.threadId,
    inReplyTo: headers["in-reply-to"] ?? null,
    references: headers["references"] ?? null,
    folderId,
    from: addresses(headers["from"])[0] ?? null,
    to: addresses(headers["to"]),
    cc: addresses(headers["cc"]),
    subject: headers["subject"] ?? null,
    bodyText: text || m.snippet || "",
    bodyHtml: html,
    receivedAt: sent ? null : at,
    sentAt: sent ? at : null,
    isDraft: labels.has("DRAFT"),
    isRead: !labels.has("UNREAD"),
    hasAttachments,
    webLink: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
    headers: Object.fromEntries(["auto-submitted", "x-autoreply", "x-autorespond", "precedence"].filter((k) => headers[k]).map((k) => [k, headers[k]])),
  };
}

// ───────────────────────── sync cursor ─────────────────────────
interface Cursor {
  mode: "list" | "history";
  startHistoryId: string;
  pageToken?: string;
  after?: number; // epoch seconds for the initial list window
}
const encodeCursor = (c: Cursor) => "gmail:" + b64url(JSON.stringify(c));
function decodeCursor(link: string): Cursor {
  if (!link.startsWith("gmail:")) throw new MailProviderError("delta_expired", "Unrecognised sync cursor; resyncing.");
  return JSON.parse(fromB64url(link.slice(6)).toString("utf8")) as Cursor;
}

// ───────────────────────── adapter ─────────────────────────
export class GmailMailProvider implements MailProvider {
  readonly kind = "gmail" as const;
  private profiles = new Map<string, string>();
  constructor(private fetchImpl: Fetch = fetch, private timeoutMs = 30_000) {}

  private async call<T>(ctx: MailContext, method: string, path: string, opts: { body?: unknown; sendLike?: boolean } = {}): Promise<T> {
    const url = GMAIL_BASE + path;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        signal: ac.signal,
        headers: { Authorization: `Bearer ${ctx.accessToken}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new MailProviderError(opts.sendLike ? "ambiguous" : "transient", `Gmail ${method} failed before a response: ${(err as Error).name}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const text = res.status === 204 ? "" : await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    let reason = "";
    let message = res.statusText;
    try {
      const j = (await res.json()) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
      reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? "";
      message = j.error?.message ?? message;
    } catch {
      /* ignore */
    }
    const retryAfter = Number(res.headers.get("retry-after") ?? "") || undefined;
    const o = { status: res.status, retryAfterSeconds: retryAfter, code: reason };
    if (res.status === 401) throw new MailProviderError("auth_expired", `Gmail 401 ${reason}`, o);
    if (res.status === 429 || /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason)) throw new MailProviderError("throttled", `Gmail ${res.status} ${reason}`, { ...o, retryAfterSeconds: retryAfter ?? 60 });
    if (res.status === 403) throw new MailProviderError(/insufficient|forbidden|PERMISSION_DENIED/i.test(reason) ? "consent_required" : "forbidden", `Gmail 403 ${reason}: ${message.slice(0, 160)}`, o);
    if (res.status === 404) throw new MailProviderError("not_found", `Gmail 404 ${reason}`, o);
    if (res.status >= 500) throw new MailProviderError(opts.sendLike ? "ambiguous" : "transient", `Gmail ${res.status} ${reason}`, o);
    throw new MailProviderError("invalid_request", `Gmail ${res.status} ${reason}: ${message.slice(0, 200)}`, o);
  }

  private async profile(ctx: MailContext) {
    return this.call<{ emailAddress: string; historyId: string }>(ctx, "GET", "/profile");
  }

  private async fromAddress(ctx: MailContext) {
    if (!this.profiles.has(ctx.mailboxId)) this.profiles.set(ctx.mailboxId, (await this.profile(ctx)).emailAddress);
    return this.profiles.get(ctx.mailboxId)!;
  }

  async getIdentity(ctx: MailContext): Promise<MailboxIdentity> {
    const p = await this.profile(ctx);
    return { providerUserId: p.emailAddress, emailAddress: p.emailAddress, displayName: p.emailAddress, tenantId: null };
  }

  async listFolders(ctx: MailContext): Promise<MailFolder[]> {
    const { labels = [] } = await this.call<{ labels?: { id: string; name: string; type: string }[] }>(ctx, "GET", "/labels");
    const role = (id: string): MailFolder["role"] => (id === "INBOX" ? "inbox" : id === "SENT" ? "sentitems" : id === "SPAM" ? "junk" : "other");
    return labels
      .filter((l) => ["INBOX", "SENT", "SPAM"].includes(l.id) || l.type === "user")
      .map((l) => ({ id: l.id, displayName: l.id === "INBOX" ? "Inbox" : l.id === "SENT" ? "Sent" : l.id === "SPAM" ? "Spam" : l.name, role: role(l.id), totalCount: 0 }));
  }

  async createDraft(ctx: MailContext, input: DraftInput): Promise<DraftRef> {
    for (const a of input.attachments) {
      if (a.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new MailProviderError("invalid_request", `Attachment ${a.filename} exceeds 3 MB; use a smaller PDF.`);
    }
    let threadId: string | undefined;
    let inReplyTo: string | null = null;
    let references: string | null = null;
    if (input.replyToProviderMessageId) {
      const parent = await this.call<GMessage>(ctx, "GET", `/messages/${encodeURIComponent(input.replyToProviderMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
      const h: Record<string, string> = {};
      for (const x of parent.payload?.headers ?? []) h[x.name.toLowerCase()] = x.value;
      threadId = parent.threadId;
      inReplyTo = h["message-id"] ?? null;
      references = [h["references"], h["message-id"]].filter(Boolean).join(" ") || null;
    }
    const raw = b64url(buildMime({ from: await this.fromAddress(ctx), to: input.to, cc: input.cc, subject: input.subject, html: input.html, text: input.text, attachments: input.attachments, inReplyTo, references }));
    const d = await this.call<{ id: string; message: { id: string; threadId: string } }>(ctx, "POST", "/drafts", { body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
    return { draftId: d.id, internetMessageId: null, conversationId: d.message.threadId, fingerprint: d.message.id };
  }

  async getDraftState(ctx: MailContext, draftId: string, hint?: SendHint): Promise<ProviderDraftState> {
    try {
      const d = await this.call<{ id: string; message: { id: string; labelIds?: string[] } }>(ctx, "GET", `/drafts/${encodeURIComponent(draftId)}?format=minimal`);
      return { exists: true, isDraft: true, fingerprint: d.message.id, parentFolderRole: "other" };
    } catch (e) {
      if (!(e instanceof MailProviderError && e.kind === "not_found")) throw e;
    }
    // Draft gone: either sent (a new SENT message appears in the thread) or deleted.
    const sent = hint ? await this.findSentCopy(ctx, { draftId, internetMessageId: null, ...hint }) : null;
    return sent ? { exists: true, isDraft: false, fingerprint: null, parentFolderRole: "sentitems" } : { exists: false, isDraft: false, fingerprint: null, parentFolderRole: null };
  }

  async deleteDraft(ctx: MailContext, draftId: string) {
    try {
      await this.call(ctx, "DELETE", `/drafts/${encodeURIComponent(draftId)}`);
    } catch (e) {
      if (!(e instanceof MailProviderError && e.kind === "not_found")) throw e;
    }
  }

  async sendDraft(ctx: MailContext, draftId: string) {
    const m = await this.call<GMessage>(ctx, "POST", "/drafts/send", { body: { id: draftId }, sendLike: true });
    return { requestId: m.id ?? null };
  }

  async findSentCopy(ctx: MailContext, ref: { draftId: string; internetMessageId: string | null } & SendHint): Promise<SentCopy | null> {
    let candidates: GMessage[] = [];
    if (ref.internetMessageId) {
      const q = encodeURIComponent(`in:sent rfc822msgid:${ref.internetMessageId.replace(/[<>]/g, "")}`);
      const list = await this.call<{ messages?: { id: string }[] }>(ctx, "GET", `/messages?q=${q}&maxResults=5`);
      for (const x of list.messages ?? []) candidates.push(await this.call<GMessage>(ctx, "GET", `/messages/${x.id}?format=metadata&metadataHeaders=Message-ID`));
    } else if (ref.conversationId) {
      try {
        const t = await this.call<{ messages?: GMessage[] }>(ctx, "GET", `/threads/${encodeURIComponent(ref.conversationId)}?format=metadata&metadataHeaders=Message-ID`);
        candidates = t.messages ?? [];
      } catch (e) {
        if (!(e instanceof MailProviderError && e.kind === "not_found")) throw e;
      }
    }
    const since = ref.since ? ref.since.getTime() - 60_000 : 0;
    const sent = candidates
      .filter((m) => m.labelIds?.includes("SENT") && !m.labelIds?.includes("DRAFT") && Number(m.internalDate ?? 0) >= since)
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))[0];
    if (!sent) return null;
    const p = parseGmailMessage(sent, "SENT");
    return { providerMessageId: sent.id, internetMessageId: p.internetMessageId, conversationId: sent.threadId, sentAt: new Date(Number(sent.internalDate)), webLink: p.webLink };
  }

  async deltaPage(ctx: MailContext, folderId: string, link: string | null, opts: { initialSince: Date }): Promise<DeltaPage> {
    let c: Cursor;
    if (!link) {
      // Capture the mailbox history position BEFORE listing, so changes made during the initial list are replayed.
      c = { mode: "list", startHistoryId: (await this.profile(ctx)).historyId, after: Math.floor(opts.initialSince.getTime() / 1000) };
    } else c = decodeCursor(link);
    const ids: string[] = [];
    let next: Cursor | null = null;
    let done: Cursor | null = null;
    if (c.mode === "list") {
      const q = new URLSearchParams({ labelIds: folderId, maxResults: "100", q: `after:${c.after ?? 0}` });
      if (c.pageToken) q.set("pageToken", c.pageToken);
      const r = await this.call<{ messages?: { id: string }[]; nextPageToken?: string }>(ctx, "GET", `/messages?${q}`);
      ids.push(...(r.messages ?? []).map((m) => m.id));
      if (r.nextPageToken) next = { ...c, pageToken: r.nextPageToken };
      else done = { mode: "history", startHistoryId: c.startHistoryId };
    } else {
      const q = new URLSearchParams({ startHistoryId: c.startHistoryId, labelId: folderId, maxResults: "100" });
      q.append("historyTypes", "messageAdded");
      q.append("historyTypes", "labelAdded");
      if (c.pageToken) q.set("pageToken", c.pageToken);
      let r: { history?: { messagesAdded?: { message: { id: string } }[]; labelsAdded?: { message: { id: string }; labelIds?: string[] }[] }[]; nextPageToken?: string; historyId?: string };
      try {
        r = await this.call(ctx, "GET", `/history?${q}`);
      } catch (e) {
        if (e instanceof MailProviderError && e.kind === "not_found") throw new MailProviderError("delta_expired", "Gmail history expired (404); full resync required.", { status: 404 });
        throw e;
      }
      for (const h of r.history ?? []) {
        for (const a of h.messagesAdded ?? []) ids.push(a.message.id);
        for (const a of h.labelsAdded ?? []) if (a.labelIds?.includes(folderId)) ids.push(a.message.id);
      }
      if (r.nextPageToken) next = { ...c, pageToken: r.nextPageToken };
      else done = { mode: "history", startHistoryId: r.historyId ?? c.startHistoryId };
    }
    const messages: SyncedMessage[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        const m = await this.call<GMessage>(ctx, "GET", `/messages/${encodeURIComponent(id)}?format=full`);
        if (!m.labelIds?.includes(folderId)) continue; // moved away since
        messages.push(parseGmailMessage(m, folderId));
      } catch (e) {
        if (e instanceof MailProviderError && e.kind === "not_found") continue; // deleted since
        throw e;
      }
    }
    return { messages, removedIds: [], nextLink: next ? encodeCursor(next) : null, deltaLink: done ? encodeCursor(done) : null };
  }

  /** Reply headers are part of format=full, so no separate header fetch is needed. */
  async getHeaders(ctx: MailContext, id: string): Promise<Record<string, string>> {
    const m = await this.call<GMessage>(ctx, "GET", `/messages/${encodeURIComponent(id)}?format=metadata`);
    return Object.fromEntries((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  }
}
