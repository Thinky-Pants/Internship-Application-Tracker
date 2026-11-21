import { defineConfig } from "@playwright/test";

/**
 * Browser tests for the main user journeys against an isolated stack:
 * in-memory database (scripts/e2e-db.ts) + production web server + worker,
 * demo mode with mock providers only. Uses the installed Microsoft Edge
 * (channel "msedge"), so no browser download is needed.
 * Run: npm run test:e2e   (builds first)
 */
const PORT = 3100;
const DB_PORT = 54330;
const env = {
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`,
  APP_BASE_URL: `http://127.0.0.1:${PORT}`,
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  DEMO_MODE: "1",
  STORAGE_DIR: "./data/e2e-files",
  E2E_DB_PORT: String(DB_PORT),
  WORKER_TICK_MS: "1000",
  INSECURE_COOKIES: "1",
  NODE_ENV: "production",
};

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge", headless: true, trace: "retain-on-failure", viewport: { width: 1400, height: 900 } },
  webServer: [
    { command: "npx tsx scripts/e2e-db.ts", port: DB_PORT, env, timeout: 120_000, reuseExistingServer: false },
    { command: `npx next start --port ${PORT}`, port: PORT, env, timeout: 120_000, reuseExistingServer: false },
    { command: "npx tsx src/worker/index.ts", env, wait: { stdout: /\[worker\] .* started/ }, timeout: 60_000, reuseExistingServer: false },
  ],
});
