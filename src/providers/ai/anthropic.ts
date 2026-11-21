/**
 * Anthropic adapter (official SDK, server-side key). Model is configurable via
 * AI_ANTHROPIC_MODEL; default claude-opus-5-5. Short suggestion tasks run at
 * low effort. Server-side refusal fallback ("default" routing) is enabled; a
 * refusal that the whole chain declines is surfaced as `refused`.
 * API access/billing is separate from any Claude.ai chat subscription.
 */
import Anthropic from "@anthropic-ai/sdk";
import { UNTRUSTED_PREAMBLE, type AiProvider, type AiRequest, type AiResponse } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export class AnthropicAiProvider implements AiProvider {
  readonly kind = "anthropic" as const;
  private client: Anthropic;
  constructor(apiKey: string, readonly model: string = process.env.AI_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const content = [req.untrusted ? `<untrusted>\n${req.untrusted}\n</untrusted>` : "", req.instruction].filter(Boolean).join("\n\n");
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxOutputTokens ?? 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: `${req.system}\n\n${UNTRUSTED_PREAMBLE}`,
      messages: [{ role: "user", content }],
    } as Parameters<Anthropic["beta"]["messages"]["create"]>[0]) as Anthropic.Beta.BetaMessage;
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return {
      text,
      model: res.model,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      usageIsEstimate: false,
      refused: res.stop_reason === "refusal",
    };
  }
}
