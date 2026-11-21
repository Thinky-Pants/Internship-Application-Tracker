"use client";
import { useMemo, useState } from "react";

const TOKEN = /\{\{\s*([a-z_.]+)(\?)?\s*\}\}/gi;

/** Composer with a live, escaped preview and a plain-text alternative. Saving creates a new immutable revision. */
export function Composer(props: {
  messageId: string;
  subject: string;
  bodyHtml: string;
  to: string;
  cc: string;
  mailboxId: string;
  mailboxes: { id: string; label: string }[];
  attachments: string[];
  cvs: { versionId: string; label: string }[];
  disabled: boolean;
  action: (fd: FormData) => void;
}) {
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.bodyHtml);
  const unresolved = useMemo(() => [...new Set([...(subject + body).matchAll(TOKEN)].map((m) => m[1]))], [subject, body]);
  const text = useMemo(() => body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim(), [body]);
  const changed = subject !== props.subject || body !== props.bodyHtml;
  return (
    <form action={props.action} className="grid gap-3 lg:grid-cols-2">
      <input type="hidden" name="messageId" value={props.messageId} />
      <fieldset disabled={props.disabled} className="flex flex-col gap-2">
        <div className="flex flex-col gap-1"><label htmlFor="c-mb">From mailbox</label>
          <select id="c-mb" name="mailboxId" defaultValue={props.mailboxId}>{props.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
        <div className="flex flex-col gap-1"><label htmlFor="c-to">To (exact recipients)</label><input id="c-to" name="to" defaultValue={props.to} /></div>
        <div className="flex flex-col gap-1"><label htmlFor="c-cc">Cc</label><input id="c-cc" name="cc" defaultValue={props.cc} /></div>
        <div className="flex flex-col gap-1"><label htmlFor="c-subj">Subject</label><input id="c-subj" name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
        <div className="flex flex-col gap-1"><label htmlFor="c-body">Body (HTML: p, br, b, i, a, ul, li)</label>
          <textarea id="c-body" name="bodyHtml" rows={14} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-[12px]" /></div>
        <fieldset className="rounded-md border border-line p-2">
          <legend className="px-1 text-[12px] text-muted">Attachments (exact CV version)</legend>
          {props.cvs.length === 0 && <p className="text-[12px] text-muted">No CVs uploaded yet.</p>}
          {props.cvs.map((c) => (
            <label key={c.versionId} className="flex items-center gap-2 text-[13px] text-fg"><input type="checkbox" name="attachment" value={c.versionId} defaultChecked={props.attachments.includes(c.versionId)} /> {c.label}</label>
          ))}
        </fieldset>
        {unresolved.length > 0 && <p role="alert" className="text-[12px] text-danger">Unresolved placeholders (block approval): {unresolved.map((u) => `{{${u}}}`).join(", ")}</p>}
        <div className="flex items-center gap-2">
          <button type="submit" className="rounded-md border border-accent bg-accent px-2.5 py-1 text-[13px] font-medium text-accent-fg">Save as new revision</button>
          {changed && <span className="text-[12px] text-warn">Unsaved changes — saving will revoke any approval and supersede queued sends of the old revision.</span>}
        </div>
      </fieldset>
      <div className="flex flex-col gap-2">
        <div className="text-[12px] text-muted">Live preview (rendered safely; links and formatting only)</div>
        <div className="rounded-md border border-line bg-surface p-3">
          <div className="mb-2 border-b border-line pb-2 text-[13px] font-semibold">{subject || "(no subject)"}</div>
          <Preview html={body} />
        </div>
        <details><summary className="cursor-pointer text-[12px]">Plain-text alternative</summary><pre className="whitespace-pre-wrap rounded-md border border-line p-2 text-[12px]">{text}</pre></details>
      </div>
    </form>
  );
}

function Preview({ html }: { html: string }) {
  // Client-side preview uses a strict allow-list; the server re-sanitises on save.
  const safe = useMemo(() => {
    if (typeof window === "undefined") return "";
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const allowed = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "A", "UL", "OL", "LI", "BLOCKQUOTE", "DIV", "SPAN", "H3", "H4"]);
    const walk = (n: Element) => {
      for (const c of [...n.children]) {
        if (!allowed.has(c.tagName)) {
          c.replaceWith(...[...c.childNodes]);
          continue;
        }
        for (const a of [...c.attributes]) if (!(c.tagName === "A" && a.name === "href" && /^(https?:|mailto:)/i.test(a.value))) c.removeAttribute(a.name);
        walk(c);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML.replace(/\{\{\s*([a-z_.]+)\??\s*\}\}/gi, '<mark title="Unresolved placeholder">{{$1}}</mark>');
  }, [html]);
  return <div className="prose-sm text-[13px] [&_p]:mb-2 [&_ul]:ml-5 [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: safe }} />;
}
