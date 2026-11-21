/**
 * Microsoft Graph mail adapter (delegated permissions, signed-in user's mailbox).
 * Verified against Microsoft Learn (see docs/PROVIDERS.md for the summary):
 *  - `Prefer: IdType="ImmutableId"` must be sent on every request.
 *  - POST /me/messages creates a draft (201, includes internetMessageId, conversationId).
 *  - Attachments < 3 MB: POST /me/messages/{id}/attachments; larger → upload session (not used;
 *    CV PDFs above 3 MB are rejected with a clear message).
 *  - POST /me/messages/{id}/send → 202 Accepted = accepted for processing, not delivery.
 *  - After send, GET /me/messages/{draftImmutableId} returns the Sent Items copy once it exists
 *    (it may take time). Fallback: filter Sent Items by internetMessageId.
 *  - Delta is per folder: GET /me/mailFolders/{id}/messages/delta; follow @odata.nextLink until
 *    @odata.deltaLink; 410 / syncStateNotFound → full resync.
 * External draft edits are detected through the message changeKey recorded after our last write.
 */
import {
  MailProviderError, type DeltaPage, type DraftInput, type DraftRef, type MailContext, type MailFolder, type MailProvider,
  type MailboxIdentity, type ProviderDraftState, type SentCopy, type SyncedMessage,
} from "./types";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MAX_SIMPLE_ATTACHMENT = 3 * 1024 * 1024;
const SELECT = [
  "id", "internetMessageId", "conversationId", "subject", "from", "toRecipients", "ccRecipients", "receivedDateTime", "sentDateTime",
  "isDraft", "isRead", "hasAttachments", "webLink", "parentFolderId", "body", "bodyPreview",
].join(",");

type Fetch = typeof fetch;

export class GraphMailProvider implements MailProvider {
  readonly kind = "graph" as const;
  constructor(private fetchImpl: Fetch = fetch, private timeoutMs = 30_000) {}

  private async call<T>(ctx: MailContext, method: string, urlOrPath: string, opts: { body?: unknown; headers?: Record<string, string>; sendLike?: boolean; raw?: boolean } = {}): Promise<{ status: number; data: T; headers: Headers }> {
    const url = urlOrPath.startsWith("http") ? urlOrPath : GRAPH_BASE + urlOrPath;
    if (!url.startsWith(GRAPH_BASE)) throw new MailProviderError("invalid_request", "Refusing to call a non-Graph URL.");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          Prefer: 'IdType="ImmutableId"',
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : { "Content-Length": "0" }),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      // Network failure / timeout. For send-like calls the request may have reached Microsoft.
      const kind = opts.sendLike ? "ambiguous" : "transient";
      throw new MailProviderError(kind, `Graph ${method} failed before a response: ${(err as Error).name}`);
    } finally {
      clearTimeout(timer);
    }
    const requestId = res.headers.get("request-id") ?? res.headers.get("client-request-id") ?? undefined;
    if (res.ok) {
      const text = res.status === 202 || res.status === 204 ? "" : await res.text();
      return { status: res.status, data: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
    }
    let code = "";
    let message = res.statusText;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      code = j.error?.code ?? "";
      message = j.error?.message ?? message;
    } catch {
      /* ignore */
    }
    const retryAfter = Number(res.headers.get("retry-after") ?? "") || undefined;
    const o = { status: res.status, retryAfterSeconds: retryAfter, requestId, code };
    if (res.status === 401) throw new MailProviderError("auth_expired", `Graph 401 ${code}`, o);
    if (res.status === 403) {
      if (/consent|authorization_requestdenied|accessdenied/i.test(code + message)) throw new MailProviderError("consent_required", `Graph 403 ${code}`, o);
      throw new MailProviderError("forbidden", `Graph 403 ${code}`, o);
    }
    if (res.status === 404) throw new MailProviderError("not_found", `Graph 404 ${code}`, o);
    if (res.status === 410 || /syncStateNotFound|resyncRequired/i.test(code)) throw new MailProviderError("delta_expired", `Graph ${res.status} ${code}`, o);
    if (res.status === 429) throw new MailProviderError("throttled", `Graph 429 ${code}`, o);
    if (res.status >= 500) {
      // 5xx on send may still have been processed → ambiguous; other calls are safe to retry.
      throw new MailProviderError(opts.sendLike ? "ambiguous" : res.status === 503 && retryAfter ? "throttled" : "transient", `Graph ${res.status} ${code}`, o);
    }
    throw new MailProviderError("invalid_request", `Graph ${res.status} ${code}: ${message.slice(0, 200)}`, o);
  }

  async getIdentity(ctx: MailContext): Promise<MailboxIdentity> {
    const { data } = await this.call<{ id: string; mail?: string; userPrincipalName: string; displayName: string }>(ctx, "GET", "/me?$select=id,mail,userPrincipalName,displayName");
    return { providerUserId: data.id, emailAddress: data.mail ?? data.userPrincipalName, displayName: data.displayName, tenantId: null };
  }

  async listFolders(ctx: MailContext): Promise<MailFolder[]> {
    const out: MailFolder[] = [];
    const wk = new Map<string, MailFolder["role"]>();
    for (const name of ["inbox", "sentitems", "junkemail"] as const) {
      try {
        const { data } = await this.call<{ id: string }>(ctx, "GET", `/me/mailFolders/${name}?$select=id`);
        wk.set(data.id, name === "junkemail" ? "junk" : name);
      } catch {
        /* folder may not exist */
      }
    }
    let next: string | null = "/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,childFolderCount&includeHiddenFolders=false";
    while (next) {
      const page: { status: number; data: { value: { id: string; displayName: string; totalItemCount: number }[]; "@odata.nextLink"?: string } } = await this.call(ctx, "GET", next);
      for (const f of page.data.value) out.push({ id: f.id, displayName: f.displayName, role: wk.get(f.id) ?? "other", totalCount: f.totalItemCount });
      next = page.data["@odata.nextLink"] ?? null;
    }
    return out;
  }

  private async changeKey(ctx: MailContext, id: string) {
    const { data } = await this.call<{ changeKey: string }>(ctx, "GET", `/me/messages/${encodeURIComponent(id)}?$select=changeKey`);
    return data.changeKey;
  }

  async createDraft(ctx: MailContext, input: DraftInput): Promise<DraftRef> {
    for (const a of input.attachments) {
      if (a.bytes.byteLength > MAX_SIMPLE_ATTACHMENT) throw new MailProviderError("invalid_request", `Attachment ${a.filename} exceeds 3 MB; upload sessions are not implemented. Use a smaller PDF.`);
    }
    const recipients = (xs: string[]) => xs.map((address) => ({ emailAddress: { address } }));
    let id: string;
    let imid: string | null;
    let conv: string | null;
    if (input.replyToProviderMessageId) {
      const { data } = await this.call<{ id: string; internetMessageId?: string; conversationId?: string }>(ctx, "POST", `/me/messages/${encodeURIComponent(input.replyToProviderMessageId)}/createReply`, { body: {} });
      id = data.id;
      // Update the reply draft body/recipients (createReply keeps threading headers).
      const { data: upd } = await this.call<{ internetMessageId?: string; conversationId?: string }>(ctx, "PATCH", `/me/messages/${encodeURIComponent(id)}`, {
        body: { subject: input.subject, body: { contentType: "HTML", content: input.html }, toRecipients: recipients(input.to), ccRecipients: recipients(input.cc) },
      });
      imid = upd.internetMessageId ?? data.internetMessageId ?? null;
      conv = upd.conversationId ?? data.conversationId ?? null;
    } else {
      const { data } = await this.call<{ id: string; internetMessageId?: string; conversationId?: string }>(ctx, "POST", "/me/messages", {
        body: { subject: input.subject, body: { contentType: "HTML", content: input.html }, toRecipients: recipients(input.to), ccRecipients: recipients(input.cc) },
      });
      id = data.id;
      imid = data.internetMessageId ?? null;
      conv = data.conversationId ?? null;
    }
    for (const a of input.attachments) {
      await this.call(ctx, "POST", `/me/messages/${encodeURIComponent(id)}/attachments`, {
        body: { "@odata.type": "#microsoft.graph.fileAttachment", name: a.filename, contentType: a.contentType, contentBytes: Buffer.from(a.bytes).toString("base64") },
      });
    }
    return { draftId: id, internetMessageId: imid, conversationId: conv, fingerprint: await this.changeKey(ctx, id) };
  }

  async getDraftState(ctx: MailContext, draftId: string): Promise<ProviderDraftState> {
    try {
      const { data } = await this.call<{ isDraft: boolean; changeKey: string; parentFolderId: string }>(ctx, "GET", `/me/messages/${encodeURIComponent(draftId)}?$select=isDraft,changeKey,parentFolderId`);
      return { exists: true, isDraft: data.isDraft, fingerprint: data.changeKey, parentFolderRole: null };
    } catch (e) {
      if (e instanceof MailProviderError && e.kind === "not_found") return { exists: false, isDraft: false, fingerprint: null, parentFolderRole: null };
      throw e;
    }
  }

  async deleteDraft(ctx: MailContext, draftId: string) {
    const st = await this.getDraftState(ctx, draftId);
    if (st.exists && st.isDraft) await this.call(ctx, "DELETE", `/me/messages/${encodeURIComponent(draftId)}`);
  }

  async sendDraft(ctx: MailContext, draftId: string) {
    const r = await this.call(ctx, "POST", `/me/messages/${encodeURIComponent(draftId)}/send`, { sendLike: true });
    return { requestId: r.headers.get("request-id") };
  }

  async findSentCopy(ctx: MailContext, ref: { draftId: string; internetMessageId: string | null }): Promise<SentCopy | null> {
    const map = (m: { id: string; internetMessageId?: string; conversationId?: string; sentDateTime?: string; webLink?: string }): SentCopy => ({
      providerMessageId: m.id, internetMessageId: m.internetMessageId ?? null, conversationId: m.conversationId ?? null, sentAt: new Date(m.sentDateTime ?? Date.now()), webLink: m.webLink ?? null,
    });
    try {
      const { data } = await this.call<{ id: string; isDraft: boolean; internetMessageId?: string; conversationId?: string; sentDateTime?: string; webLink?: string }>(
        ctx, "GET", `/me/messages/${encodeURIComponent(ref.draftId)}?$select=id,isDraft,internetMessageId,conversationId,sentDateTime,webLink,parentFolderId`,
      );
      if (!data.isDraft && data.sentDateTime) return map(data);
    } catch (e) {
      if (!(e instanceof MailProviderError && e.kind === "not_found")) throw e;
    }
    if (ref.internetMessageId) {
      const filter = encodeURIComponent(`internetMessageId eq '${ref.internetMessageId.replace(/'/g, "''")}'`);
      const { data } = await this.call<{ value: { id: string; internetMessageId?: string; conversationId?: string; sentDateTime?: string; webLink?: string }[] }>(
        ctx, "GET", `/me/mailFolders/sentitems/messages?$filter=${filter}&$select=id,internetMessageId,conversationId,sentDateTime,webLink`,
      );
      if (data.value[0]) return map(data.value[0]);
    }
    return null;
  }

  async deltaPage(ctx: MailContext, folderId: string, link: string | null, opts: { initialSince: Date }): Promise<DeltaPage> {
    const url = link ?? `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${opts.initialSince.toISOString()}`)}`;
    const { data } = await this.call<{
      value: (Record<string, any> & { "@removed"?: { reason: string } })[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    }>(ctx, "GET", url, { headers: { Prefer: 'IdType="ImmutableId", odata.maxpagesize=50' } });
    const messages: SyncedMessage[] = [];
    const removedIds: string[] = [];
    for (const m of data.value) {
      if (m["@removed"]) {
        removedIds.push(m.id);
        continue;
      }
      const addr = (r: { emailAddress?: { address?: string } } | undefined) => r?.emailAddress?.address?.toLowerCase() ?? null;
      const html = m.body?.contentType === "html" ? String(m.body.content ?? "") : null;
      messages.push({
        providerMessageId: m.id,
        internetMessageId: m.internetMessageId ?? null,
        conversationId: m.conversationId ?? null,
        inReplyTo: null,
        references: null,
        folderId,
        from: addr(m.from),
        to: (m.toRecipients ?? []).map(addr).filter(Boolean),
        cc: (m.ccRecipients ?? []).map(addr).filter(Boolean),
        subject: m.subject ?? null,
        bodyText: m.body?.contentType === "text" ? String(m.body.content ?? "") : String(m.bodyPreview ?? ""),
        bodyHtml: html,
        receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
        sentAt: m.sentDateTime ? new Date(m.sentDateTime) : null,
        isDraft: Boolean(m.isDraft),
        isRead: Boolean(m.isRead),
        hasAttachments: Boolean(m.hasAttachments),
        webLink: m.webLink ?? null,
        headers: {},
      });
    }
    return { messages, removedIds, nextLink: data["@odata.nextLink"] ?? null, deltaLink: data["@odata.deltaLink"] ?? null };
  }

  /** Reply headers are not part of the delta $select; fetched for unmatched inbound messages only. */
  async getHeaders(ctx: MailContext, id: string): Promise<Record<string, string>> {
    const { data } = await this.call<{ internetMessageHeaders?: { name: string; value: string }[] }>(ctx, "GET", `/me/messages/${encodeURIComponent(id)}?$select=internetMessageHeaders`);
    return Object.fromEntries((data.internetMessageHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  }

  // ── Subscriptions (cloud webhook mode) ──
  async createSubscription(ctx: MailContext, args: { folderId: string; notificationUrl: string; lifecycleUrl: string; clientState: string; expires: Date }) {
    const { data } = await this.call<{ id: string; expirationDateTime: string }>(ctx, "POST", "/subscriptions", {
      body: {
        changeType: "created,updated",
        notificationUrl: args.notificationUrl,
        lifecycleNotificationUrl: args.lifecycleUrl,
        resource: `/me/mailFolders('${args.folderId}')/messages`,
        expirationDateTime: args.expires.toISOString(),
        clientState: args.clientState,
      },
    });
    return { id: data.id, expiresAt: new Date(data.expirationDateTime) };
  }

  async renewSubscription(ctx: MailContext, id: string, expires: Date) {
    const { data } = await this.call<{ expirationDateTime: string }>(ctx, "PATCH", `/subscriptions/${encodeURIComponent(id)}`, { body: { expirationDateTime: expires.toISOString() } });
    return new Date(data.expirationDateTime);
  }

  async deleteSubscription(ctx: MailContext, id: string) {
    await this.call(ctx, "DELETE", `/subscriptions/${encodeURIComponent(id)}`);
  }
}

/** Max lifetime for Outlook message subscriptions without resource data: 10,080 minutes. */
export const GRAPH_MAX_SUBSCRIPTION_MINUTES = 10_080;
