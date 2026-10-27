/** fal.ai image-to-video (queue API) behind VideoProvider (spec 6.6). Model is configurable. */
import type { ClipRequest, ClipResult, VideoProvider } from "./types";
import { ProviderError, fetchWithRetry } from "./http";

export interface FalOptions {
  apiKey: string;
  /** fal model path, e.g. "fal-ai/kling-video/v2.1/standard/image-to-video" (config/providers.json) */
  model: string;
  usdPerSecond: number;
  pollMs?: number;
  maxWaitMs?: number;
  baseUrl?: string;
}

export class FalVideo implements VideoProvider {
  readonly id = "fal";
  constructor(private readonly o: FalOptions) {
    if (!o.apiKey) throw new ProviderError("FAL_API_KEY is not configured", undefined, false, "invalid");
  }
  get model() {
    return this.o.model;
  }

  private headers() {
    return { "content-type": "application/json", authorization: `Key ${this.o.apiKey}` };
  }

  async generate(req: ClipRequest): Promise<ClipResult> {
    const base = this.o.baseUrl ?? "https://queue.fal.run";
    const submit = await fetchWithRetry(
      `${base}/${this.o.model}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          prompt: req.prompt,
          image_url: `data:${req.imageMime};base64,${req.image.toString("base64")}`,
          duration: String(req.seconds),
          aspect_ratio: "16:9",
        }),
      },
      { label: "fal.submit", retries: 3, timeoutMs: 120_000 },
    );
    const job = (await submit.json()) as { status_url?: string; response_url?: string };
    if (!job.status_url || !job.response_url) throw new ProviderError("fal.submit: missing status_url/response_url");

    const started = Date.now();
    const poll = this.o.pollMs ?? 5000;
    const maxWait = this.o.maxWaitMs ?? 10 * 60_000;
    for (;;) {
      if (Date.now() - started > maxWait) throw new ProviderError("fal: timed out waiting for the clip", undefined, true, "timeout");
      const st = await fetchWithRetry(job.status_url, { headers: this.headers() }, { label: "fal.status", retries: 3, timeoutMs: 30_000 });
      const s = (await st.json()) as { status?: string };
      if (s.status === "COMPLETED") break;
      if (s.status && !["IN_QUEUE", "IN_PROGRESS"].includes(s.status)) throw new ProviderError(`fal: job ended with status ${s.status}`);
      await new Promise((r) => setTimeout(r, poll));
    }

    const out = await fetchWithRetry(job.response_url, { headers: this.headers() }, { label: "fal.result", retries: 3, timeoutMs: 60_000 });
    const result = (await out.json()) as { video?: { url?: string } };
    const videoUrl = result.video?.url;
    if (!videoUrl) throw new ProviderError("fal: no video url in result");
    const dl = await fetchWithRetry(videoUrl, {}, { label: "fal.download", retries: 3, timeoutMs: 120_000 });
    return { video: Buffer.from(await dl.arrayBuffer()), costUsd: req.seconds * this.o.usdPerSecond, seconds: req.seconds };
  }
}
