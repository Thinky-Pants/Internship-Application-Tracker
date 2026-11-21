/**
 * Zero-install embedded PostgreSQL (PGlite) server for trying the app without
 * Docker or a PostgreSQL install. Persists to ./data/pglite.
 *
 * Limitations (documented in docs/SETUP-WINDOWS.md): PGlite is a single
 * connection multiplexed across clients, so concurrent transactions from the
 * web app and worker are serialised and isolation is not equivalent to a real
 * server. Use it for the demo and development only — use real PostgreSQL
 * (Docker Compose or the Windows installer) before sending real email.
 */
import "../src/worker/env";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import fs from "node:fs";

const dir = process.env.PGLITE_DIR ?? "./data/pglite";
fs.mkdirSync(dir, { recursive: true });
const db = await PGlite.create(dir);
const port = Number(process.env.PGLITE_PORT ?? 54329);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 } as ConstructorParameters<typeof PGLiteSocketServer>[0]);
await server.start();
console.log(`Embedded PostgreSQL (PGlite) listening on 127.0.0.1:${port}`);
console.log(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`);
const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
