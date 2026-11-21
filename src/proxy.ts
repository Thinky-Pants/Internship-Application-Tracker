/**
 * Optimistic redirect for signed-out visitors. This is NOT the authorization
 * check — every page, action and route handler verifies the session itself.
 */
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = [/^\/login/, /^\/setup/, /^\/api\/webhooks\//, /^\/api\/health/, /^\/manifest\.webmanifest$/, /^\/sw\.js$/, /^\/icons\//, /^\/offline/];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();
  if (!req.cookies.get("iom_session")) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
