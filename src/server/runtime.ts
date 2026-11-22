/**
 * Runtime wiring for web and worker processes. Provider selection:
 *  - mailbox.provider "graph" → Microsoft Graph, "gmail" → Gmail API, "mock" → file-backed mock
 *  - Apollo: real REST adapter when an API key is stored (encrypted); mock only
 *    in demo mode or when APOLLO_MODE=mock; otherwise null (unconfigured).
 *  - AI: Anthropic/OpenAI when keys are stored; mock when AI_MODE=mock or demo.
 * Demo mode never reaches a paid/real provider.
 */
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { systemClock, offsetClock, type Clock } from "@/lib/clock";
import { getStorage } from "@/lib/storage";
import { decryptSecret } from "@/lib/crypto";
import { GraphMailProvider } from "@/providers/mail/graph";
import { FileMockStore, MockMailProvider } from "@/providers/mail/mock";
import { graphAuthConfig, refreshTokens } from "@/providers/mail/graph-auth";
import { GmailMailProvider } from "@/providers/mail/gmail";
import { googleAuthConfig, refreshGoogleTokens } from "@/providers/mail/google-auth";
import { ApolloRestProvider } from "@/providers/apollo/rest";
import { MockApolloProvider } from "@/providers/apollo/mock";
import { AnthropicAiProvider } from "@/providers/ai/anthropic";
import { OpenAiProvider } from "@/providers/ai/openai";
import { MockAiProvider } from "@/providers/ai/mock";
import type { Services } from "@/domain/services";

export const isDemoMode = () => process.env.DEMO_MODE === "1";

/** Demo "simulated time": an offset stored in a file shared by web and worker. */
function demoClock(): Clock {
  if (!isDemoMode()) return systemClock;
  return {
    now: () => {
      try {
        const off = Number(fs.readFileSync("data/demo-clock-offset", "utf8")) || 0;
        return offsetClock(off).now();
      } catch {
        return new Date();
      }
    },
  };
}

let cached: Services | null = null;

export function getServices(role: "web" | "worker" = "web"): Services {
  if (cached) return cached;
  const db = getDb();
  const clock = demoClock();
  const graph = new GraphMailProvider();
  const gmail = new GmailMailProvider();
  const mock = new MockMailProvider(new FileMockStore(), clock);
  const workerId = `${role}-${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const cfg = graphAuthConfig();
  const gcfg = googleAuthConfig();
  cached = {
    db,
    clock,
    storage: getStorage(),
    workerId,
    mailProvider: (kind) => {
      if (kind === "graph" || kind === "gmail") {
        if (isDemoMode()) throw new Error("Demo mode never uses a real mailbox.");
        return kind === "graph" ? graph : gmail;
      }
      return mock;
    },
    apollo: async (ownerId) => {
      if (isDemoMode() || process.env.APOLLO_MODE === "mock") return new MockApolloProvider();
      const [c] = await db.select().from(s.providerCredentials).where(and(eq(s.providerCredentials.ownerId, ownerId), eq(s.providerCredentials.provider, "apollo")));
      if (!c?.secretEnc) return null;
      return new ApolloRestProvider(decryptSecret(c.secretEnc));
    },
    ai: async (ownerId, provider) => {
      if (isDemoMode() || process.env.AI_MODE === "mock") return new MockAiProvider();
      const wanted = provider ?? process.env.AI_DEFAULT_PROVIDER ?? "anthropic";
      const [c] = await db.select().from(s.providerCredentials).where(and(eq(s.providerCredentials.ownerId, ownerId), eq(s.providerCredentials.provider, wanted)));
      if (!c?.secretEnc) return null;
      const model = (c.config as { model?: string }).model;
      if (wanted === "openai") return new OpenAiProvider(decryptSecret(c.secretEnc), model ?? process.env.AI_OPENAI_MODEL ?? "");
      return new AnthropicAiProvider(decryptSecret(c.secretEnc), model || undefined);
    },
    refreshOAuthToken: async (provider, rt) => {
      if (provider === "graph" && cfg) return refreshTokens(cfg, rt);
      if (provider === "gmail" && gcfg) return refreshGoogleTokens(gcfg, rt);
      throw new Error(`OAuth client for ${provider} is not configured.`);
    },
  };
  return cached;
}
