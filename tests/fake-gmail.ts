/**
 * In-memory fake of the Gmail REST endpoints the adapter uses, following the
 * documented behaviour: drafts.send deletes the draft and creates a NEW
 * message (new id, SENT label, same thread); drafts.update replaces the draft's
 * message (new message id); history older than the retained window → 404.
 */
import { fromB64url } from "@/providers/mail/gmail";

interface FMsg {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  headers: { name: string; value: string }[];
  text: string;
  attachments: string[];
}
interface HistoryRec {
  id: number;
  messageId: string;
  labelIds: string[];
}

export class FakeGmail {
  email = "student@gmail.example";
  now: () => number;
  private seq = 1000;
  private hist = 5000;
  minValidHistory = 0;
  historyPageSize = 2;
  messages = new Map<string, FMsg>();
  drafts = new Map<string, string>(); // draftId -> messageId
  history: HistoryRec[] = [];
  faults: { path: RegExp; kind: "network_after_apply" | "status"; status?: number; reason?: string }[] = [];
  calls: string[] = [];

  constructor(now: () => number) {
    this.now = now;
  }

  private id(p: string) {
    return `${p}${++this.seq}`;
  }

  private addHistory(m: FMsg) {
    this.history.push({ id: ++this.hist, messageId: m.id, labelIds: [...m.labelIds] });
  }

  private fromRaw(raw: string, threadId: string | undefined, labels: string[]): FMsg {
    const mime = fromB64url(raw).toString("utf8");
    const [head] = mime.split("\r\n\r\n");
    const headers = head.split("\r\n").map((l) => {
      const i = l.indexOf(":");
      return { name: l.slice(0, i), value: l.slice(i + 1).trim() };
    });
    const tp = mime.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/);
    const text = tp ? Buffer.from(tp[1].replace(/\r\n/g, ""), "base64").toString("utf8") : "";
    const attachments = [...mime.matchAll(/Content-Disposition: attachment; filename="([^"]+)"/g)].map((m) => m[1]);
    return { id: this.id("m"), threadId: threadId ?? this.id("t"), labelIds: labels, internalDate: this.now(), headers, text, attachments };
  }

  /** Simulate mail arriving in the inbox (optionally replying to a message). */
  deliver(from: string, subject: string, text: string, replyTo?: { messageId: string }) {
    const parent = replyTo ? this.messages.get(replyTo.messageId) : undefined;
    const parentMid = parent?.headers.find((h) => h.name.toLowerCase() === "message-id")?.value;
    const m: FMsg = {
      id: this.id("m"), threadId: parent?.threadId ?? this.id("t"), labelIds: ["INBOX", "UNREAD"], internalDate: this.now(),
      headers: [{ name: "From", value: from }, { name: "To", value: this.email }, { name: "Subject", value: subject }, { name: "Message-ID", value: `<${this.seq}@sender.example>` },
        ...(parentMid ? [{ name: "In-Reply-To", value: parentMid }, { name: "References", value: parentMid }] : [])],
      text, attachments: [],
    };
    this.messages.set(m.id, m);
    this.addHistory(m);
    return m;
  }

  /** Simulate the owner editing a draft inside Gmail (replaces the message). */
  editDraftInGmail(draftId: string) {
    const old = this.messages.get(this.drafts.get(draftId)!)!;
    this.messages.delete(old.id);
    const m = { ...old, id: this.id("m"), headers: old.headers.map((h) => (h.name === "Subject" ? { ...h, value: h.value + " (edited)" } : h)) };
    this.messages.set(m.id, m);
    this.drafts.set(draftId, m.id);
  }

  sentMessages() {
    return [...this.messages.values()].filter((m) => m.labelIds.includes("SENT"));
  }

  private payload(m: FMsg, format: string) {
    const base = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: String(m.internalDate) };
    if (format === "minimal") return base;
    const headers = format === "metadata" ? m.headers : m.headers;
    return {
      ...base,
      snippet: m.text.slice(0, 80),
      payload: {
        mimeType: "multipart/mixed",
        headers,
        parts: format === "full" ? [{ mimeType: "text/plain", body: { data: Buffer.from(m.text).toString("base64url") } }, ...m.attachments.map((f) => ({ mimeType: "application/pdf", filename: f, body: { attachmentId: "a1" } }))] : [],
      },
    };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const fault = this.faults.find((f) => f.path.test(`${method} ${path}`));
    const json = (status: number, data: unknown) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    const notFound = () => json(404, { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } });
    if (fault?.kind === "status") {
      this.faults.splice(this.faults.indexOf(fault), 1);
      return json(fault.status!, { error: { code: fault.status, message: "fault", errors: [{ reason: fault.reason ?? "backendError" }] } });
    }
    const result = this.route(method, path, url, body, json, notFound);
    if (fault?.kind === "network_after_apply") {
      this.faults.splice(this.faults.indexOf(fault), 1);
      throw new TypeError("fetch failed (simulated network drop after the request was applied)");
    }
    return result;
  };

  private route(method: string, path: string, url: URL, body: any, json: (s: number, d: unknown) => Response, notFound: () => Response): Response {
    const fmt = url.searchParams.get("format") ?? "full";
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/profile") return json(200, { emailAddress: this.email, historyId: String(this.hist) });
    if (method === "GET" && path === "/labels") return json(200, { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" }, { id: "DRAFT", name: "DRAFT", type: "system" }, { id: "Label_1", name: "Recruiting", type: "user" }] });
    if (method === "POST" && path === "/drafts") {
      const msg = this.fromRaw(body.message.raw, body.message.threadId, ["DRAFT"]);
      this.messages.set(msg.id, msg);
      const did = this.id("r");
      this.drafts.set(did, msg.id);
      return json(200, { id: did, message: { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds } });
    }
    if (method === "POST" && path === "/drafts/send") {
      const mid = this.drafts.get(body.id);
      if (!mid) return notFound();
      const draft = this.messages.get(mid)!;
      this.drafts.delete(body.id);
      this.messages.delete(mid);
      const sent: FMsg = { ...draft, id: this.id("m"), labelIds: ["SENT"], internalDate: this.now(), headers: [...draft.headers.filter((h) => h.name.toLowerCase() !== "message-id"), { name: "Message-ID", value: `<gm${this.seq}@mail.gmail.example>` }] };
      this.messages.set(sent.id, sent);
      this.addHistory(sent);
      return json(200, { id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds });
    }
    if ((m = path.match(/^\/drafts\/([^/]+)$/))) {
      const did = decodeURIComponent(m[1]);
      const mid = this.drafts.get(did);
      if (!mid) return notFound();
      if (method === "DELETE") {
        this.drafts.delete(did);
        this.messages.delete(mid);
        return json(204, null);
      }
      return json(200, { id: did, message: this.payload(this.messages.get(mid)!, "minimal") });
    }
    if (method === "GET" && path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      const label = url.searchParams.get("labelIds");
      let list = [...this.messages.values()];
      if (label) list = list.filter((x) => x.labelIds.includes(label));
      const after = q.match(/after:(\d+)/);
      if (after) list = list.filter((x) => x.internalDate / 1000 >= Number(after[1]));
      const rid = q.match(/rfc822msgid:(\S+)/);
      if (rid) list = list.filter((x) => x.headers.some((h) => h.name.toLowerCase() === "message-id" && h.value.replace(/[<>]/g, "") === rid[1]));
      if (q.includes("in:sent")) list = list.filter((x) => x.labelIds.includes("SENT"));
      list.sort((a, b) => b.internalDate - a.internalDate);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = 2;
      const page = list.slice(start, start + size);
      return json(200, { messages: page.map((x) => ({ id: x.id, threadId: x.threadId })), ...(start + size < list.length ? { nextPageToken: String(start + size) } : {}) });
    }
    if ((m = path.match(/^\/messages\/([^/]+)$/)) && method === "GET") {
      const msg = this.messages.get(decodeURIComponent(m[1]));
      return msg ? json(200, this.payload(msg, fmt)) : notFound();
    }
    if ((m = path.match(/^\/threads\/([^/]+)$/)) && method === "GET") {
      const tid = decodeURIComponent(m[1]);
      const list = [...this.messages.values()].filter((x) => x.threadId === tid);
      return list.length ? json(200, { id: tid, messages: list.map((x) => this.payload(x, fmt)) }) : notFound();
    }
    if (method === "GET" && path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (start < this.minValidHistory) return notFound();
      const label = url.searchParams.get("labelId");
      const recs = this.history.filter((h) => h.id > start && (!label || h.labelIds.includes(label)));
      const off = Number(url.searchParams.get("pageToken") ?? 0);
      const page = recs.slice(off, off + this.historyPageSize);
      return json(200, {
        history: page.map((h) => ({ id: String(h.id), messagesAdded: [{ message: { id: h.messageId, threadId: "", labelIds: h.labelIds } }] })),
        historyId: String(this.hist),
        ...(off + this.historyPageSize < recs.length ? { nextPageToken: String(off + this.historyPageSize) } : {}),
      });
    }
    return json(400, { error: { code: 400, message: `fake: unsupported ${method} ${path}`, errors: [{ reason: "badRequest" }] } });
  }
}
