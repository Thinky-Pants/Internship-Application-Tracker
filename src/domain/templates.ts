/**
 * Templates with validated placeholders. Syntax: {{name}} (required) or
 * {{name?}} (optional, renders empty). Unknown placeholder names are errors.
 * Missing required values block approval.
 */
import sanitizeHtml from "sanitize-html";

export const PLACEHOLDERS: Record<string, string> = {
  "company.name": "Company name",
  "company.industry": "Primary industry",
  "company.city": "Company city",
  "company.country": "Company country",
  "contact.first_name": "Contact first name",
  "contact.full_name": "Contact full name",
  "contact.title": "Contact title",
  role: "Role / opportunity",
  project: "Relevant project (from verified profile)",
  skill: "Relevant skill (from verified profile)",
  availability: "Availability (from verified profile)",
  personalization: "Evidence-backed personalisation sentence",
  "me.name": "Your name",
  signature: "Signature (HTML)",
};

const TOKEN_RE = /\{\{\s*([a-z_.]+)(\?)?\s*\}\}/gi;

export interface RenderResult {
  subject: string;
  html: string;
  text: string;
  missing: string[];   // required placeholders with no value → block approval
  unknown: string[];   // not a supported placeholder → block approval
  used: string[];
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function scanPlaceholders(text: string): { name: string; optional: boolean }[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => ({ name: m[1].toLowerCase(), optional: m[2] === "?" }));
}

export function renderTemplate(tpl: { subject: string; bodyHtml: string; requiredPlaceholders?: string[] }, values: Record<string, string | null | undefined>): RenderResult {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const used = new Set<string>();
  const sub = (input: string, html: boolean) =>
    input.replace(TOKEN_RE, (_m, rawName: string, opt?: string) => {
      const name = rawName.toLowerCase();
      used.add(name);
      if (!(name in PLACEHOLDERS)) {
        unknown.add(name);
        return `{{${name}}}`;
      }
      const v = values[name];
      if (v == null || String(v).trim() === "") {
        if (!opt) missing.add(name);
        return opt ? "" : `{{${name}}}`;
      }
      // signature is trusted owner-authored HTML (sanitised below); other values are escaped.
      return html && name !== "signature" ? esc(String(v)) : String(v);
    });
  for (const r of tpl.requiredPlaceholders ?? []) if (values[r] == null || String(values[r]).trim() === "") missing.add(r);
  const subject = sub(tpl.subject, false).replace(/\s+/g, " ").trim();
  const html = sanitizeOutboundHtml(sub(tpl.bodyHtml, true));
  return { subject, html, text: htmlToText(html), missing: [...missing], unknown: [...unknown], used: [...used] };
}

export function sanitizeOutboundHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "b", "strong", "i", "em", "u", "a", "ul", "ol", "li", "blockquote", "div", "span", "h3", "h4"],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["https", "http", "mailto"],
  });
}

/** Inbound mail is untrusted: strip scripts, styles, remote images, forms, iframes. */
export function sanitizeInboundHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "b", "strong", "i", "em", "u", "a", "ul", "ol", "li", "blockquote", "div", "span", "table", "thead", "tbody", "tr", "td", "th", "h1", "h2", "h3", "h4", "pre", "code", "hr"],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["https", "mailto"],
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }) },
  });
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|blockquote|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, (_m, href, t) => (t && t !== href ? `${t} (${href})` : href))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
