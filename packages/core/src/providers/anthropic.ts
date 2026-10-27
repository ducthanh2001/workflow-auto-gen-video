/** Anthropic Messages API (streaming) behind LlmClient. */
import type { LlmClient } from "../planner";
import { ProviderError, fetchWithRetry } from "./http";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** flat estimate per call (config/pricing.json) */
  costPerCallUsd?: number;
  baseUrl?: string;
}

export class AnthropicLlm implements LlmClient {
  constructor(private readonly o: AnthropicOptions) {
    if (!o.apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not configured", undefined, false, "invalid");
  }

  async complete(input: { system: string; user: string; maxTokens?: number }) {
    const res = await fetchWithRetry(
      `${this.o.baseUrl ?? "https://api.anthropic.com"}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.o.apiKey,
          "anthropic-version": "2023-06-01",
        },
        // Streaming: long plans (100+ scenes) take minutes and non-streaming requests can be cut.
        body: JSON.stringify({
          model: this.o.model,
          max_tokens: input.maxTokens ?? 16000,
          stream: true,
          system: input.system,
          messages: [{ role: "user", content: input.user }],
        }),
      },
      { label: "anthropic.messages", retries: 3, timeoutMs: 15 * 60_000 },
    );
    if (!res.body) throw new ProviderError("anthropic.messages: empty body");

    let text = "";
    let buf = "";
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) text += ev.delta.text;
        if (ev.type === "error") throw new ProviderError(`anthropic.messages stream error: ${ev.error?.message ?? "unknown"}`, undefined, true);
      }
    }
    if (!text) throw new ProviderError("anthropic.messages returned no text");
    return { text, costUsd: this.o.costPerCallUsd ?? 0 };
  }
}
