/**
 * Dependency container passed to domain services. Runtime wiring lives in
 * src/server/runtime.ts; tests construct their own with mocks and a FakeClock.
 */
import type { Db } from "@/db/client";
import type { Clock } from "@/lib/clock";
import type { Storage } from "@/lib/storage";
import type { MailProvider } from "@/providers/mail/types";
import type { ApolloProvider } from "@/providers/apollo/types";
import type { AiProvider } from "@/providers/ai/types";

export interface Services {
  db: Db;
  clock: Clock;
  storage: Storage;
  /** Provider for a mailbox's provider kind ("graph" | "mock"). */
  mailProvider(kind: string): MailProvider;
  /** Apollo adapter (real or mock) or null when unconfigured. */
  apollo(ownerId: string): Promise<ApolloProvider | null>;
  ai(ownerId: string, provider?: string): Promise<AiProvider | null>;
  workerId: string;
  /** Refresh delegated OAuth tokens for a mailbox provider ("graph" | "gmail"). Injected so tests can stub it. */
  refreshOAuthToken?: (provider: string, refreshToken: string) => Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date }>;
}
