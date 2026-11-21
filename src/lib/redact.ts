/** Redaction for routine diagnostics: never log tokens, keys or full addresses. */
const TOKEN_RE = /(bearer\s+)[a-z0-9._~+/=-]{8,}/gi;
const EMAIL_RE = /([a-z0-9._%+-])[a-z0-9._%+-]*@([a-z0-9.-]+\.[a-z]{2,})/gi;
const KEYISH_RE = /\b(sk-[a-z0-9_-]{4})[a-z0-9_-]+/gi;
const JSON_SECRET_RE = /"(access_token|refresh_token|id_token|client_secret|api_key|password)"\s*:\s*"[^"]*"/gi;

export function redact(s: string | undefined | null, max = 400): string {
  if (!s) return "";
  return s
    .replace(TOKEN_RE, "$1[redacted]")
    .replace(KEYISH_RE, "$1[redacted]")
    .replace(JSON_SECRET_RE, '"$1":"[redacted]"')
    .replace(EMAIL_RE, "$1***@$2")
    .slice(0, max);
}

export function errorSummary(err: unknown): string {
  if (err instanceof Error) return redact(`${err.name}: ${err.message}`);
  return redact(String(err));
}
