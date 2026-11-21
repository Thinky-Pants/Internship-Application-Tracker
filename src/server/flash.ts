import "server-only";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

/** Redirect back with a short status message (rendered by <Flash/>). */
export function back(path: string, opts: { msg?: string; err?: string } = {}): never {
  // Refresh shared layout data too (global pause banner, worker status) after a mutation.
  revalidatePath("/", "layout");
  const u = new URL(path, "http://x");
  if (opts.msg) u.searchParams.set("msg", opts.msg.slice(0, 300));
  if (opts.err) u.searchParams.set("err", opts.err.slice(0, 500));
  redirect(u.pathname + u.search);
}

export function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) throw e;
  if (e instanceof Error) {
    const issues = (e as Error & { issues?: string[] }).issues;
    return issues?.length ? `${e.message} ${issues.join(" ")}` : e.message;
  }
  return String(e);
}
