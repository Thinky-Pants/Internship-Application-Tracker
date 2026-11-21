/**
 * Mail provider contract. Implemented by the Microsoft Graph adapter and a
 * deterministic mock. Errors are classified so the dispatcher can tell safe
 * pre-submission retries from ambiguous outcomes.
 */
export interface MailAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface DraftInput {
  subject: string;
  html: string;
  text: string;
  to: string[];
  cc: string[];
  attachments: MailAttachment[];
  /** When set, the draft is created as an in-thread reply to this provider message. */
  replyToProviderMessageId?: string | null;
}

export interface DraftRef {
  draftId: string;              // immutable ID where supported
  internetMessageId: string | null;
  conversationId: string | null;
  /** Fingerprint of provider-side content right after we wrote it (detects external edits). */
  fingerprint: string;
}

export interface ProviderDraftState {
  exists: boolean;
  isDraft: boolean;
  fingerprint: string | null;
  parentFolderRole: string | null;
}

export interface SentCopy {
  providerMessageId: string;
  internetMessageId: string | null;
  conversationId: string | null;
  sentAt: Date;
  webLink: string | null;
}

export interface SyncedMessage {
  providerMessageId: string;
  internetMessageId: string | null;
  conversationId: string | null;
  inReplyTo: string | null;
  references: string | null;
  folderId: string;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  isDraft: boolean;
  isRead: boolean;
  hasAttachments: boolean;
  webLink: string | null;
  headers: Record<string, string>;
}

export interface DeltaPage {
  messages: SyncedMessage[];
  removedIds: string[];
  nextLink: string | null;   // more pages in this round
  deltaLink: string | null;  // round complete; persist
}

export interface MailFolder {
  id: string;
  displayName: string;
  role: "inbox" | "sentitems" | "junk" | "other";
  totalCount: number;
}

export interface MailboxIdentity {
  providerUserId: string;
  emailAddress: string;
  displayName: string;
  tenantId: string | null;
}

export type MailErrorKind =
  | "auth_expired"       // token invalid/expired/revoked → mailbox "expired"
  | "consent_required"   // tenant/admin consent missing → mailbox "restricted"
  | "forbidden"
  | "throttled"          // 429/503 with Retry-After
  | "transient"          // failed before the request could take effect → safe to retry
  | "ambiguous"          // request may have reached provider (timeout / connection reset after write)
  | "invalid_request"    // terminal
  | "not_found"
  | "delta_expired";     // sync state lost → full resync

export class MailProviderError extends Error {
  constructor(
    public kind: MailErrorKind,
    message: string,
    public opts: { status?: number; retryAfterSeconds?: number; requestId?: string; code?: string } = {},
  ) {
    super(message);
    this.name = "MailProviderError";
  }
}

export interface MailContext {
  mailboxId: string;
  accessToken: string;
}

export interface MailProvider {
  readonly kind: "graph" | "mock";
  getIdentity(ctx: MailContext): Promise<MailboxIdentity>;
  listFolders(ctx: MailContext): Promise<MailFolder[]>;
  createDraft(ctx: MailContext, input: DraftInput): Promise<DraftRef>;
  getDraftState(ctx: MailContext, draftId: string): Promise<ProviderDraftState>;
  deleteDraft(ctx: MailContext, draftId: string): Promise<void>;
  /** Submits an existing draft. Resolves on acceptance (e.g. HTTP 202) — NOT proof of delivery. */
  sendDraft(ctx: MailContext, draftId: string): Promise<{ requestId: string | null }>;
  /** Locate the sent copy of a submitted draft, if it exists yet. */
  findSentCopy(ctx: MailContext, ref: { draftId: string; internetMessageId: string | null }): Promise<SentCopy | null>;
  /** One page of per-folder delta. Pass a nextLink/deltaLink, or null for initial sync. */
  deltaPage(ctx: MailContext, folderId: string, link: string | null, opts: { initialSince: Date }): Promise<DeltaPage>;
}
