# AI features

AI is optional. It only produces **suggestions**: it cannot approve, send, change budgets, read credentials or run app actions. Company pages and incoming email are passed as delimited untrusted data. Only **verified** candidate-profile sections and **approved** company evidence are used for drafting.

## Direct providers (optional)

- **Anthropic** (official `@anthropic-ai/sdk`): default model `claude-opus-5-5`, configurable in Settings or `AI_ANTHROPIC_MODEL`. Requests use low effort and the server-side refusal fallback.
- **OpenAI** (official `openai` SDK): set the model explicitly (Settings or `AI_OPENAI_MODEL`); no model ID is assumed.
- **API accounts and billing are separate from chat subscriptions.** A Claude.ai or ChatGPT subscription does not include API access or credits.
- Keys are stored encrypted server-side. Usage is recorded per job (provider-reported tokens, or labelled estimates); a monthly token budget blocks further calls.

Features: draft a company-specific email from approved facts (unsupported statements flagged), suggest CV with reason, summarise a conversation with next action, suggest a reply category with confidence (manual choices are never overwritten), contact-role priorities and missing research (via the exchange).

## Manual exchange (any chat tool, no API key)

**Imports & Exports → AI exchange.**

1. **Export** a package (`iom.ai-exchange/v1`) for up to 50 companies: stable record IDs and revisions, your verified profile, CV metadata, approved evidence, task instructions, a ready-to-paste `prompt`, the `resultSchema` (JSON Schema) and an `exampleResultLine`. No mailbox content or credentials are included.
2. Paste the package into Claude, ChatGPT or Gemini and ask it to follow the `prompt`.
3. **Import** the JSON Lines result. Each line is validated strictly (unknown fields rejected), matched by `packageId` + `recordId`, checked against the current record revision (changed records are marked *stale*), and deduplicated by content hash. Results are staged for review.
4. **Accept or reject** each result. Accepting creates an unapproved draft, unreviewed AI evidence, a CV selection or a research task. Imported "verified"/"sent" claims are impossible by schema. Nothing is sent automatically.

See `samples/ai-exchange-sample.json` for a small example.
