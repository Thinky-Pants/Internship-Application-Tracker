/**
 * OpenAI adapter (official SDK, Chat Completions). The model must be set
 * explicitly with AI_OPENAI_MODEL (or in Settings) — no model id is assumed.
 * API billing is separate from ChatGPT subscriptions.
 */
import OpenAI from "openai";
import { UNTRUSTED_PREAMBLE, type AiProvider, type AiRequest, type AiResponse } from "./types";

export class OpenAiProvider implements AiProvider {
  readonly kind = "openai" as const;
  private client: OpenAI;
  constructor(apiKey: string, readonly model: string) {
    if (!model) throw new Error("Set AI_OPENAI_MODEL (or the model in Settings) to use OpenAI.");
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: `${req.system}\n\n${UNTRUSTED_PREAMBLE}` },
        { role: "user", content: [req.untrusted ? `<untrusted>\n${req.untrusted}\n</untrusted>` : "", req.instruction].filter(Boolean).join("\n\n") },
      ],
      max_completion_tokens: req.maxOutputTokens ?? 4000,
    });
    const choice = res.choices[0];
    return {
      text: choice?.message?.content ?? "",
      model: res.model,
      inputTokens: res.usage?.prompt_tokens ?? null,
      outputTokens: res.usage?.completion_tokens ?? null,
      usageIsEstimate: !res.usage,
      refused: Boolean(choice?.message?.refusal),
    };
  }
}
