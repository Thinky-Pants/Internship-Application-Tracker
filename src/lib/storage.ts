/**
 * Private file storage. Files are never served statically; downloads go
 * through authenticated route handlers.
 *  - local: STORAGE_DIR on a private volume (development / single host)
 *  - s3:    any S3-compatible object store (AWS S3, Cloudflare R2, Backblaze B2,
 *           MinIO) with AWS Signature V4; bucket must be private.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Storage {
  readonly kind: "local" | "s3";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

function safeKey(key: string) {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid storage key.");
  return key;
}

export class LocalStorage implements Storage {
  readonly kind = "local" as const;
  constructor(private root = path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.STORAGE_DIR ?? "./data/files")) {}
  private p(key: string) {
    return path.join(this.root, safeKey(key));
  }
  async put(key: string, bytes: Uint8Array) {
    const f = this.p(key);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    await fs.promises.writeFile(f + ".tmp", bytes);
    await fs.promises.rename(f + ".tmp", f);
  }
  async get(key: string) {
    return new Uint8Array(await fs.promises.readFile(this.p(key)));
  }
  async exists(key: string) {
    return fs.existsSync(this.p(key));
  }
  async delete(key: string) {
    await fs.promises.rm(this.p(key), { force: true });
  }
  async list(prefix: string) {
    const base = this.p(prefix || ".");
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    await walk(base);
    return out;
  }
}

export class S3Storage implements Storage {
  readonly kind = "s3" as const;
  constructor(private cfg: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {}

  private sign(method: string, key: string, body: Uint8Array, query = "", extraHeaders: Record<string, string> = {}) {
    const url = new URL(`${this.cfg.endpoint.replace(/\/$/, "")}/${this.cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}${query ? "?" + query : ""}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extraHeaders };
    const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalQuery = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const canonical = [method, url.pathname, canonicalQuery, signedHeaders.map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim()}\n`).join(""), signedHeaders.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
    const hmac = (k: crypto.BinaryLike, d: string) => crypto.createHmac("sha256", k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac("AWS4" + this.cfg.secretAccessKey, date), this.cfg.region), "s3"), "aws4_request");
    const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
    delete headers.host;
    return { url: url.toString(), headers };
  }

  async put(key: string, bytes: Uint8Array, contentType: string) {
    const { url, headers } = this.sign("PUT", safeKey(key), bytes, "", { "content-type": contentType });
    const res = await fetch(url, { method: "PUT", headers, body: Buffer.from(bytes) });
    if (!res.ok) throw new Error(`Object storage PUT failed (${res.status}).`);
  }
  async get(key: string) {
    const { url, headers } = this.sign("GET", safeKey(key), new Uint8Array());
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Object storage GET failed (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async exists(key: string) {
    const { url, headers } = this.sign("HEAD", safeKey(key), new Uint8Array());
    return (await fetch(url, { method: "HEAD", headers })).ok;
  }
  async delete(key: string) {
    const { url, headers } = this.sign("DELETE", safeKey(key), new Uint8Array());
    await fetch(url, { method: "DELETE", headers });
  }
  async list(prefix: string) {
    const q = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const { url, headers } = this.sign("GET", "", new Uint8Array(), q);
    const res = await fetch(url.replace(/\/\?/, "?"), { headers });
    const xml = await res.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  }
}

let _storage: Storage | null = null;
export function getStorage(): Storage {
  if (_storage) return _storage;
  if (process.env.STORAGE_DRIVER === "s3") {
    const need = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !process.env[k]);
    if (need.length) throw new Error(`STORAGE_DRIVER=s3 but missing ${need.join(", ")}.`);
    _storage = new S3Storage({ endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!, accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! });
  } else _storage = new LocalStorage();
  return _storage;
}

export function setStorage(s: Storage) {
  _storage = s;
}

export class MemoryStorage implements Storage {
  readonly kind = "local" as const;
  files = new Map<string, Uint8Array>();
  async put(k: string, b: Uint8Array) {
    this.files.set(safeKey(k), b);
  }
  async get(k: string) {
    const f = this.files.get(k);
    if (!f) throw new Error("not found");
    return f;
  }
  async exists(k: string) {
    return this.files.has(k);
  }
  async delete(k: string) {
    this.files.delete(k);
  }
  async list(p: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(p));
  }
}
