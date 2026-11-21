/**
 * Deterministic mock mail provider for development, demo mode and tests.
 * It NEVER sends real mail. State is a plain JSON object so it can be kept in
 * memory (tests) or persisted to a file (demo across web/worker processes).
 *
 * Fault injection lets tests reproduce: throttling with Retry-After, transient
 * failures, an ambiguous timeout after the provider actually accepted the
 * send, revoked tokens, expired delta tokens and duplicate delta replays.
 */
import fs from "node:fs";
import path from "node:path";
import type { Clock } from "@/lib/clock";
import { systemClock } from "@/lib/clock";
import { sha256Hex } from "@/lib/crypto";
import {
  MailProviderError, type DeltaPage, type DraftInput, type DraftRef, type MailContext, type MailFolder, type MailProvider,
  type MailboxIdentity, type ProviderDraftState, type SentCopy, type SyncedMessage, type MailErrorKind,
} from "./types";

interface MockMsg extends Omit<SyncedMessage, "receivedAt" | "sentAt"> {
  receivedAt: string | null;
  sentAt: string | null;
  sentVisibleAt: string | null; // sent copy appears after this instant
  attachmentNames: string[];
}

interface ChangeEntry {
  seq: number;
  folderId: string;
  id: string;
  removed: boolean;
}

export interface MockMailState {
  identity: MailboxIdentity;
  counter: number;
  seq: number;
  messages: Record<string, MockMsg>;
  changes: ChangeEntry[];
  /** Delta tokens with seq below this are "expired". */
  minValidSeq: number;
  revokedTokens: string[];
  faults: { op: string; kind: MailErrorKind; appliedBeforeError?: boolean; retryAfterSeconds?: number; times?: number }[];
  sentCount: number;
  replayDuplicates: boolean;
}

export const MOCK_FOLDERS: MailFolder[] = [
  { id: "mock-inbox", displayName: "Inbox", role: "inbox", totalCount: 0 },
  { id: "mock-sent", displayName: "Sent Items", role: "sentitems", totalCount: 0 },
  { id: "mock-drafts", displayName: "Drafts", role: "other", totalCount: 0 },
  { id: "mock-recruiting", displayName: "Recruiting (rule-filtered)", role: "other", totalCount: 0 },
];

export function newMockState(email = "demo.student@example.test"): MockMailState {
  return {
    identity: { providerUserId: "mock-user-1", emailAddress: email, displayName: "Demo Student (mock mailbox)", tenantId: null },
    counter: 0,
    seq: 0,
    messages: {},
    changes: [],
    minValidSeq: 0,
    revokedTokens: [],
    faults: [],
    sentCount: 0,
    replayDuplicates: false,
  };
}

export interface MockStore {
  load(mailboxId: string): MockMailState;
  save(mailboxId: string, state: MockMailState): void;
}

export class MemoryMockStore implements MockStore {
  states = new Map<string, MockMailState>();
  load(id: string) {
    if (!this.states.has(id)) this.states.set(id, newMockState());
    return this.states.get(id)!;
  }
  save(id: string, st: MockMailState) {
    this.states.set(id, st);
  }
}

/** File-backed store so web and worker processes see the same mock mailbox. */
export class FileMockStore implements MockStore {
  constructor(private dir = path.resolve(/* turbopackIgnore: true */ process.cwd(), "data", "mock-mail")) {}
  private file(id: string) {
    return path.join(this.dir, `${id.replace(/[^a-z0-9-]/gi, "")}.json`);
  }
  load(id: string) {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as MockMailState;
    } catch {
      return newMockState();
    }
  }
  save(id: string, st: MockMailState) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file(id) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, this.file(id));
  }
}

function fingerprintOf(subject: string | null, body: string, to: string[], cc: string[], attachments: string[]) {
  return sha256Hex(JSON.stringify([subject ?? "", body, [...to].sort(), [...cc].sort(), [...attachments].sort()])).slice(0, 32);
}

export class MockMailProvider implements MailProvider {
  readonly kind = "mock" as const;
  constructor(private store: MockStore, private clock: Clock = systemClock, private opts: { sentCopyDelayMs?: number; pageSize?: number } = {}) {}

  // ── helpers ──
  private with<T>(ctx: MailContext, op: string, fn: (st: MockMailState) => T): T {
    const st = this.store.load(ctx.mailboxId);
    if (st.revokedTokens.includes(ctx.accessToken)) throw new MailProviderError("auth_expired", "Mock: token revoked (simulated).", { status: 401 });
    const fault = st.faults.find((f) => f.op === op);
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.times <= 0) st.faults.splice(st.faults.indexOf(fault), 1);
      if (fault.appliedBeforeError) {
        // The provider performs the operation, then the client sees a failure (e.g. timeout after 202).
        fn(st);
        this.store.save(ctx.mailboxId, st);
      } else this.store.save(ctx.mailboxId, st);
      throw new MailProviderError(fault.kind, `Mock fault on ${op}: ${fault.kind}`, { retryAfterSeconds: fault.retryAfterSeconds, status: fault.kind === "throttled" ? 429 : undefined });
    }
    const out = fn(st);
    this.store.save(ctx.mailboxId, st);
    return out;
  }

  private nextId(st: MockMailState, prefix: string) {
    st.counter++;
    return `${prefix}-${String(st.counter).padStart(5, "0")}`;
  }

  private change(st: MockMailState, folderId: string, id: string, removed = false) {
    st.seq++;
    st.changes.push({ seq: st.seq, folderId, id, removed });
  }

  // ── MailProvider ──
  async getIdentity(ctx: MailContext) {
    return this.with(ctx, "getIdentity", (st) => st.identity);
  }

  async listFolders(ctx: MailContext) {
    return this.with(ctx, "listFolders", (st) =>
      MOCK_FOLDERS.map((f) => ({ ...f, totalCount: Object.values(st.messages).filter((m) => m.folderId === f.id).length })),
    );
  }

  async createDraft(ctx: MailContext, input: DraftInput): Promise<DraftRef> {
    return this.with(ctx, "createDraft", (st) => {
      const id = this.nextId(st, "mock-msg");
      const parent = input.replyToProviderMessageId ? st.messages[input.replyToProviderMessageId] : undefined;
      if (input.replyToProviderMessageId && !parent) throw new MailProviderError("not_found", "Mock: reply target not found.");
      const imid = `<${id}@mock.example.test>`;
      const msg: MockMsg = {
        providerMessageId: id,
        internetMessageId: imid,
        conversationId: parent?.conversationId ?? `mock-conv-${id}`,
        inReplyTo: parent?.internetMessageId ?? null,
        references: parent ? [parent.references, parent.internetMessageId].filter(Boolean).join(" ") : null,
        folderId: "mock-drafts",
        from: st.identity.emailAddress,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        bodyText: input.text,
        bodyHtml: input.html,
        receivedAt: null,
        sentAt: null,
        sentVisibleAt: null,
        isDraft: true,
        isRead: true,
        hasAttachments: input.attachments.length > 0,
        webLink: `https://mock.example.test/mail/${id}`,
        headers: {},
        attachmentNames: input.attachments.map((a) => `${a.filename}:${sha256Hex(a.bytes).slice(0, 12)}`),
      };
      st.messages[id] = msg;
      return { draftId: id, internetMessageId: imid, conversationId: msg.conversationId, fingerprint: fingerprintOf(msg.subject, input.html, input.to, input.cc, msg.attachmentNames) };
    });
  }

  async getDraftState(ctx: MailContext, draftId: string): Promise<ProviderDraftState> {
    return this.with(ctx, "getDraftState", (st) => {
      const m = st.messages[draftId];
      if (!m) return { exists: false, isDraft: false, fingerprint: null, parentFolderRole: null };
      return {
        exists: true,
        isDraft: m.isDraft,
        fingerprint: fingerprintOf(m.subject, m.bodyHtml ?? "", m.to, m.cc, m.attachmentNames),
        parentFolderRole: MOCK_FOLDERS.find((f) => f.id === m.folderId)?.role ?? "other",
      };
    });
  }

  async deleteDraft(ctx: MailContext, draftId: string) {
    this.with(ctx, "deleteDraft", (st) => {
      if (st.messages[draftId]?.isDraft) delete st.messages[draftId];
    });
  }

  async sendDraft(ctx: MailContext, draftId: string) {
    return this.with(ctx, "sendDraft", (st) => {
      const m = st.messages[draftId];
      if (!m || !m.isDraft) throw new MailProviderError("not_found", "Mock: draft not found or already sent.", { status: 404 });
      const now = this.clock.now();
      m.isDraft = false;
      m.folderId = "mock-sent";
      m.sentAt = now.toISOString();
      m.sentVisibleAt = new Date(now.getTime() + (this.opts.sentCopyDelayMs ?? 0)).toISOString();
      st.sentCount++;
      this.change(st, "mock-sent", draftId);
      return { requestId: `mock-req-${st.sentCount}` };
    });
  }

  async findSentCopy(ctx: MailContext, ref: { draftId: string; internetMessageId: string | null }): Promise<SentCopy | null> {
    return this.with(ctx, "findSentCopy", (st) => {
      const m = st.messages[ref.draftId] ?? Object.values(st.messages).find((x) => ref.internetMessageId && x.internetMessageId === ref.internetMessageId);
      if (!m || m.isDraft || m.folderId !== "mock-sent" || !m.sentAt) return null;
      if (m.sentVisibleAt && new Date(m.sentVisibleAt) > this.clock.now()) return null;
      return { providerMessageId: m.providerMessageId, internetMessageId: m.internetMessageId, conversationId: m.conversationId, sentAt: new Date(m.sentAt), webLink: m.webLink };
    });
  }

  async deltaPage(ctx: MailContext, folderId: string, link: string | null, opts: { initialSince: Date }): Promise<DeltaPage> {
    return this.with(ctx, "deltaPage", (st) => {
      const pageSize = this.opts.pageSize ?? 50;
      let fromSeq = 0;
      let offset = 0;
      let untilSeq = st.seq;
      if (link) {
        const [, kind, f, a, b, c] = link.split(":");
        if (f !== folderId) throw new MailProviderError("invalid_request", "Mock: link for another folder.");
        if (kind === "delta") {
          fromSeq = Number(a);
          if (fromSeq < st.minValidSeq) throw new MailProviderError("delta_expired", "Mock: syncStateNotFound", { status: 410, code: "syncStateNotFound" });
        } else {
          fromSeq = Number(a);
          offset = Number(b);
          untilSeq = Number(c);
        }
      }
      const visible = (m: MockMsg) => !m.isDraft && (!m.sentVisibleAt || new Date(m.sentVisibleAt) <= this.clock.now());
      // Latest change per id in (fromSeq, untilSeq].
      const latest = new Map<string, ChangeEntry>();
      for (const ch of st.changes) if (ch.folderId === folderId && ch.seq > fromSeq && ch.seq <= untilSeq) latest.set(ch.id, ch);
      let entries = [...latest.values()].sort((a, b) => a.seq - b.seq);
      if (!link) entries = entries.filter((e) => e.removed || !st.messages[e.id] || new Date(st.messages[e.id].receivedAt ?? st.messages[e.id].sentAt ?? 0) >= opts.initialSince);
      if (st.replayDuplicates && entries.length) entries = [...entries, entries[0]];
      const page = entries.slice(offset, offset + pageSize);
      const messages: SyncedMessage[] = [];
      const removedIds: string[] = [];
      for (const e of page) {
        const m = st.messages[e.id];
        if (e.removed || !m || m.folderId !== folderId) removedIds.push(e.id);
        else if (visible(m)) messages.push({ ...m, receivedAt: m.receivedAt ? new Date(m.receivedAt) : null, sentAt: m.sentAt ? new Date(m.sentAt) : null });
      }
      const more = offset + pageSize < entries.length;
      return {
        messages,
        removedIds,
        nextLink: more ? `mock:next:${folderId}:${fromSeq}:${offset + pageSize}:${untilSeq}` : null,
        deltaLink: more ? null : `mock:delta:${folderId}:${untilSeq}`,
      };
    });
  }

  // ── Simulation controls (demo/tests only) ──
  simulateInbound(mailboxId: string, msg: { from: string; to?: string[]; subject: string; text: string; inReplyToProviderId?: string; folderId?: string; headers?: Record<string, string>; at?: Date }): string {
    const st = this.store.load(mailboxId);
    const parent = msg.inReplyToProviderId ? st.messages[msg.inReplyToProviderId] : undefined;
    const id = this.nextId(st, "mock-in");
    const folderId = msg.folderId ?? "mock-inbox";
    st.messages[id] = {
      providerMessageId: id,
      internetMessageId: `<${id}@sender.example.test>`,
      conversationId: parent?.conversationId ?? `mock-conv-${id}`,
      inReplyTo: parent?.internetMessageId ?? null,
      references: parent ? [parent.references, parent.internetMessageId].filter(Boolean).join(" ") : null,
      folderId,
      from: msg.from,
      to: msg.to ?? [st.identity.emailAddress],
      cc: [],
      subject: msg.subject,
      bodyText: msg.text,
      bodyHtml: null,
      receivedAt: (msg.at ?? this.clock.now()).toISOString(),
      sentAt: null,
      sentVisibleAt: null,
      isDraft: false,
      isRead: false,
      hasAttachments: false,
      webLink: `https://mock.example.test/mail/${id}`,
      headers: msg.headers ?? {},
      attachmentNames: [],
    };
    this.change(st, folderId, id);
    this.store.save(mailboxId, st);
    return id;
  }

  /** Simulate a message the user sent from Outlook directly (outside this app). */
  simulateExternalSent(mailboxId: string, msg: { to: string[]; subject: string; text: string }): string {
    const st = this.store.load(mailboxId);
    const id = this.nextId(st, "mock-ext");
    const now = this.clock.now().toISOString();
    st.messages[id] = {
      providerMessageId: id, internetMessageId: `<${id}@mock.example.test>`, conversationId: `mock-conv-${id}`, inReplyTo: null, references: null,
      folderId: "mock-sent", from: st.identity.emailAddress, to: msg.to, cc: [], subject: msg.subject, bodyText: msg.text, bodyHtml: null,
      receivedAt: null, sentAt: now, sentVisibleAt: now, isDraft: false, isRead: true, hasAttachments: false, webLink: null, headers: {}, attachmentNames: [],
    };
    this.change(st, "mock-sent", id);
    this.store.save(mailboxId, st);
    return id;
  }

  /** Simulate someone editing the Outlook draft outside the app. */
  simulateExternalDraftEdit(mailboxId: string, draftId: string, newSubject: string) {
    const st = this.store.load(mailboxId);
    if (st.messages[draftId]) st.messages[draftId].subject = newSubject;
    this.store.save(mailboxId, st);
  }

  injectFault(mailboxId: string, fault: MockMailState["faults"][number]) {
    const st = this.store.load(mailboxId);
    st.faults.push(fault);
    this.store.save(mailboxId, st);
  }

  revokeToken(mailboxId: string, token: string) {
    const st = this.store.load(mailboxId);
    st.revokedTokens.push(token);
    this.store.save(mailboxId, st);
  }

  expireDeltaTokens(mailboxId: string) {
    const st = this.store.load(mailboxId);
    st.minValidSeq = st.seq + 1;
    this.store.save(mailboxId, st);
  }

  setReplayDuplicates(mailboxId: string, on: boolean) {
    const st = this.store.load(mailboxId);
    st.replayDuplicates = on;
    this.store.save(mailboxId, st);
  }

  state(mailboxId: string) {
    return this.store.load(mailboxId);
  }
}
