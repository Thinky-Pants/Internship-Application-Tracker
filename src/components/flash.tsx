import { Notice } from "./ui";

export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const msg = typeof sp.msg === "string" ? sp.msg : null;
  const err = typeof sp.err === "string" ? sp.err : null;
  if (!msg && !err) return null;
  return <div className="mb-3">{err ? <Notice tone="danger">{err}</Notice> : <Notice tone="ok">{msg}</Notice>}</div>;
}
