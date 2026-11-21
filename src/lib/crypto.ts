import crypto from "node:crypto";

/**
 * Secrets at rest: AES-256-GCM with a key supplied via APP_ENCRYPTION_KEY
 * (base64, 32 bytes). The key lives in the environment / secret manager,
 * never in the database. Ciphertext format: v1.<iv>.<tag>.<data> (base64url).
 * Key rotation: set APP_ENCRYPTION_KEY_PREVIOUS to the old key; decrypt tries
 * the current key first and then the previous one.
 */
function loadKey(name: string): Buffer | null {
  const raw = process.env[name];
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded.`);
  return key;
}

function currentKey(): Buffer {
  const key = loadKey("APP_ENCRYPTION_KEY");
  if (!key) throw new Error("APP_ENCRYPTION_KEY is not set; cannot store provider credentials.");
  return key;
}

export function encryptionConfigured(): boolean {
  try {
    return loadKey("APP_ENCRYPTION_KEY") !== null;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", currentKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(enc: string): string {
  const [v, ivb, tagb, datab] = enc.split(".");
  if (v !== "v1" || !ivb || !tagb || datab === undefined) throw new Error("Unrecognised ciphertext format.");
  const keys = [loadKey("APP_ENCRYPTION_KEY"), loadKey("APP_ENCRYPTION_KEY_PREVIOUS")].filter(Boolean) as Buffer[];
  for (const key of keys) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivb, "base64url"));
      d.setAuthTag(Buffer.from(tagb, "base64url"));
      return Buffer.concat([d.update(Buffer.from(datab, "base64url")), d.final()]).toString("utf8");
    } catch {
      /* try next key */
    }
  }
  throw new Error("Unable to decrypt secret with configured keys.");
}

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Owner passphrase hashing (scrypt). The app never asks for mailbox passwords. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltb, hashb] = stored.split("$");
  if (alg !== "scrypt" || !saltb || !hashb) return false;
  const expected = Buffer.from(hashb, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(saltb, "base64url"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

/** Stable JSON (sorted keys) for content hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + stableStringify(o[k]))
      .join(",") +
    "}"
  );
}
