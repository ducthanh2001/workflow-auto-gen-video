/** Gemini image generation behind ImageProvider (spec 6.5). Model id comes from env. */
import sharp from "sharp";
import type { ImageProvider, ImageRequest, ImageResult } from "./types";
import { ProviderError, fetchWithRetry } from "./http";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  usdPerImage: number;
  baseUrl?: string;
}

interface Part {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

export class GeminiImage implements ImageProvider {
  readonly id = "gemini";
  constructor(private readonly o: GeminiOptions) {
    if (!o.apiKey) throw new ProviderError("GEMINI_API_KEY is not configured", undefined, false, "invalid");
    if (!o.model) throw new ProviderError("GEMINI_IMAGE_MODEL is not configured", undefined, false, "invalid");
  }
  get model() {
    return this.o.model;
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const parts: unknown[] = [{ text: req.prompt }];
    for (const r of req.refs.slice(0, 3)) {
      parts.push({ inline_data: { mime_type: r.mime, data: r.data.toString("base64") } });
    }
    const url = `${this.o.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${encodeURIComponent(this.o.model)}:generateContent`;

    const call = async (modalities: string[]) => {
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          // key in a header, never in the URL (URLs end up in logs)
          headers: { "content-type": "application/json", "x-goog-api-key": this.o.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { responseModalities: modalities, imageConfig: { aspectRatio: req.aspect } },
          }),
        },
        { label: "gemini.image", retries: 3, timeoutMs: 180_000 },
      );
      return (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
      };
    };

    let json: Awaited<ReturnType<typeof call>>;
    try {
      json = await call(["IMAGE"]);
    } catch (e) {
      // some image models only accept TEXT+IMAGE
      if (e instanceof ProviderError && e.status === 400) json = await call(["TEXT", "IMAGE"]);
      else throw e;
    }

    const cand = json.candidates?.[0];
    const img = cand?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
    const b64 = img?.inlineData?.data ?? img?.inline_data?.data;
    if (!b64) {
      const why = json.promptFeedback?.blockReason ?? cand?.finishReason ?? "no image in response";
      throw new ProviderError(`gemini.image returned no image (${why})`, undefined, false, "blocked");
    }
    return {
      image: Buffer.from(b64, "base64"),
      mime: img?.inlineData?.mimeType ?? img?.inline_data?.mime_type ?? "image/png",
      costUsd: this.o.usdPerImage,
    };
  }
}

/** Upscale/crop to the working size (3840x2160 keeps Ken Burns sharp). */
export async function fitTo16x9(input: Buffer, width = 3840, height = 2160): Promise<Buffer> {
  return sharp(input).resize(width, height, { fit: "cover", kernel: "lanczos3" }).png({ compressionLevel: 6 }).toBuffer();
}

export interface ImageQuality {
  ok: boolean;
  reason?: "too_small" | "blank";
  width: number;
  height: number;
  stdev: number;
}

/** Auto-checks (spec 6.5): dimensions and "not blank". OCR is a separate, optional pass. */
export async function checkImageQuality(input: Buffer): Promise<ImageQuality> {
  const img = sharp(input);
  const meta = await img.metadata();
  const stats = await img.stats();
  const stdev = stats.channels.slice(0, 3).reduce((a, c) => a + c.stdev, 0) / 3;
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1024 || height < 576) return { ok: false, reason: "too_small", width, height, stdev };
  if (stdev < 4) return { ok: false, reason: "blank", width, height, stdev };
  return { ok: true, width, height, stdev };
}
