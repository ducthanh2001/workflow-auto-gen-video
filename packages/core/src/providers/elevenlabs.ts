/** ElevenLabs text-to-speech behind TtsProvider (spec 6.4). */
import type { TtsProvider, TtsRequest, TtsResult } from "./types";
import { ProviderError, fetchWithRetry } from "./http";

export interface ElevenLabsOptions {
  apiKey: string;
  /** credits per character by model id (config/pricing.json) */
  creditsPerChar: Record<string, number>;
  usdPerCredit: number;
  baseUrl?: string;
}

export class ElevenLabsTts implements TtsProvider {
  readonly id = "elevenlabs";
  constructor(private readonly o: ElevenLabsOptions) {
    if (!o.apiKey) throw new ProviderError("ELEVENLABS_API_KEY is not configured", undefined, false, "invalid");
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    if (!req.voiceId || req.voiceId.startsWith("REPLACE_")) {
      throw new ProviderError("No ElevenLabs voice id configured: set it in config/voices.json", undefined, false, "invalid");
    }
    const body: Record<string, unknown> = {
      text: req.text,
      model_id: req.model,
      voice_settings: req.settings,
    };
    if (req.previousText) body.previous_text = req.previousText;
    if (req.nextText) body.next_text = req.nextText;

    const url = `${this.o.baseUrl ?? "https://api.elevenlabs.io"}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=mp3_44100_128`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": this.o.apiKey, accept: "audio/mpeg" },
        body: JSON.stringify(body),
      },
      { label: "elevenlabs.tts", retries: 3, timeoutMs: 120_000 },
    );
    const audio = Buffer.from(await res.arrayBuffer());
    const credits = (this.o.creditsPerChar[req.model] ?? 1) * req.text.length;
    return { audio, mime: "audio/mpeg", costUsd: credits * this.o.usdPerCredit };
  }
}
