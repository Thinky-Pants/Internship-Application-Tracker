/**
 * Single-owner authentication. Every server component, server action and
 * route handler that touches private data calls requireOwner(). Session
 * tokens are random, stored only as SHA-256 hashes, sent in an httpOnly,
 * SameSite=Lax cookie (Secure in production). Server Actions are POST-only
 * and Next.js checks their Origin; route handlers that mutate call
 * assertSameOrigin(). Mailbox passwords are never requested (OAuth only).
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "@/lib/crypto";

export const SESSION_COOKIE = "iom_session";
const SESSION_DAYS = 14;

export async function ownerCount() {
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(s.owners);
  return n;
}

export async function currentOwner() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const [row] = await db.select({ owner: s.owners, session: s.sessions }).from(s.sessions).innerJoin(s.owners, eq(s.owners.id, s.sessions.ownerId))
    .where(and(eq(s.sessions.tokenHash, sha256Hex(token)), gt(s.sessions.expiresAt, new Date())));
  return row?.owner ?? null;
}

export async function requireOwner() {
  const owner = await currentOwner();
  if (!owner) redirect("/login");
  return owner;
}

/** For route handlers: returns null instead of redirecting. */
export async function ownerOrNull() {
  return currentOwner();
}

async function issueSession(ownerId: string) {
  const token = randomToken(32);
  const h = await headers();
  await getDb().insert(s.sessions).values({ ownerId, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000), userAgent: (h.get("user-agent") ?? "").slice(0, 200) });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function createFirstOwner(email: string, displayName: string, password: string) {
  if ((await ownerCount()) > 0) throw new Error("An owner already exists. Sign in instead.");
  if (password.length < 12) throw new Error("Use a passphrase of at least 12 characters.");
  const db = getDb();
  const [o] = await db.insert(s.owners).values({ email: email.trim().toLowerCase(), displayName: displayName.trim(), passwordHash: hashPassword(password) }).returning();
  await db.insert(s.settings).values({ ownerId: o.id }).onConflictDoNothing();
  await issueSession(o.id);
  return o;
}

const attempts = new Map<string, { n: number; until: number }>();

export async function login(email: string, password: string) {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) throw new Error("Too many attempts. Wait a minute and try again.");
  const [o] = await getDb().select().from(s.owners).where(eq(s.owners.email, email.trim().toLowerCase()));
  const ok = o ? verifyPassword(password, o.passwordHash) : (verifyPassword(password, "scrypt$AAAA$AAAA"), false);
  if (!ok) {
    const n = (a?.n ?? 0) + 1;
    attempts.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    throw new Error("Email or passphrase is incorrect.");
  }
  attempts.delete(ip);
  await issueSession(o!.id);
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getDb().delete(s.sessions).where(eq(s.sessions.tokenHash, sha256Hex(token)));
  jar.delete(SESSION_COOKIE);
}

/** CSRF defence for mutating route handlers. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) throw new Response("Cross-origin request rejected", { status: 403 });
}
