/**
 * Microsoft Graph change notifications (cloud mode only).
 *  - Validation: echo ?validationToken as text/plain within 10 s.
 *  - Notifications: verify clientState against the stored hash, record with a
 *    dedupe key, enqueue a delta sync, and reply 202 quickly (< 3 s).
 * Notification content is never trusted; it only triggers a sync.
 */
import { getServices } from "@/server/runtime";
import { recordNotifications, webhooksEnabled } from "@/domain/mail/subscriptions";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("validationToken");
  if (token) return new Response(token, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (!webhooksEnabled()) return new Response(null, { status: 202 });
  let body: { value?: Record<string, unknown>[] } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }
  try {
    await recordNotifications(getServices(), body, url.searchParams.get("lifecycle") === "1");
  } catch (e) {
    console.error("[webhook] record failed:", (e as Error).message); // periodic safety sync recovers
  }
  return new Response(null, { status: 202 });
}
