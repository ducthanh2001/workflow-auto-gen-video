/**
 * APIZ image gateway behind ImageProvider: OpenAI-style POST {base}/images/generations with a Bearer key.
 * The answer carries a short-lived URL (or base64) which is downloaded right away.
 * With a reference picture (the hero sheet) it calls POST {base}/images/edits instead: multipart with
 * model, prompt and ONE picture in the "image" field (the gateway takes a single file per call, under 5 MB).
 * Without one it stays on /images/generations. The character is also kept by the written lock in the prompt.
 */
import sharp from "sharp";
import type { ImageProvider, ImageRef, ImageRequest, ImageResult } from "./types";
import { ProviderError, fetchWithRetry } from "./http";

export interface ApizOptions {
  apiKey: string;
  model: string;
  usdPerImage: number;
  /** pixel size sent as "size", 16:9 so nothing is cropped away (default 1024x576) */
  size?: string;
  /** default https://api.apiz.vn/v1 */
  baseUrl?: string;
}

interface ImagesResponse {
  data?: Array<{ url?: string; b64_json?: string; mime_type?: string }>;
}

const DEFAULT_BASE = "https://api.apiz.vn/v1";
const DEFAULT_SIZE = "1024x576";

/** Providers phrase refusals differently; these are the usual markers of a content-policy block. */
const BLOCKED_RE = /safety|moderation|content[_ -]?policy|policy violation|blocked|not allowed/i;

const MAX_REF_BYTES = 4_500_000; // the gateway accepts JPG/PNG under 5 MB

/** The reference as JPG/PNG under the size limit (re-encoded as JPEG when it is too big or another type). */
async function fitUnderLimit(ref: ImageRef): Promise<ImageRef> {
  if (ref.data.length <= MAX_REF_BYTES && /^image\/(png|jpe?g)$/.test(ref.mime)) return ref;
  for (const quality of [92, 80, 65]) {
    const data = await sharp(ref.data).flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer();
    if (data.length <= MAX_REF_BYTES) return { mime: "image/jpeg", data };
  }
  const data = await sharp(ref.data).flatten({ background: "#ffffff" }).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { mime: "image/jpeg", data };
}

export class ApizImage implements ImageProvider {
  readonly id = "apiz";
  readonly acceptsRefs = true;
  readonly maxRefs = 1;
  constructor(private readonly o: ApizOptions) {
    if (!o.apiKey) throw new ProviderError("APIZ_API_KEY is not configured", undefined, false, "invalid");
    if (!o.model) throw new ProviderError("APIZ_IMAGE_MODEL is not configured", undefined, false, "invalid");
  }
  get model() {
    return this.o.model;
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const base = (this.o.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    const ref = req.refs[0];
    let res: Response;
    try {
      let target = `${base}/images/generations`;
      let init: RequestInit;
      if (ref) {
        // multipart: fetch sets the boundary itself, so no content-type header here
        const picture = await fitUnderLimit(ref);
        const form = new FormData();
        form.append("model", this.o.model);
        form.append("prompt", req.prompt);
        form.append("image", new Blob([new Uint8Array(picture.data)], { type: picture.mime }), picture.mime === "image/png" ? "reference.png" : "reference.jpg");
        target = `${base}/images/edits`;
        init = { method: "POST", headers: { authorization: `Bearer ${this.o.apiKey}` }, body: form };
      } else {
        init = {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
          body: JSON.stringify({ model: this.o.model, prompt: req.prompt, size: this.o.size ?? DEFAULT_SIZE }),
        };
      }
      res = await fetchWithRetry(
        target,
        init,
        // generation takes 20 to 35 s; few retries because a retried request can be billed again
        { label: "apiz.image", retries: 2, timeoutMs: 180_000 },
      );
    } catch (e) {
      if (e instanceof ProviderError && e.status === 400 && BLOCKED_RE.test(e.message)) {
        throw new ProviderError(e.message, e.status, false, "blocked");
      }
      throw e;
    }

    const json = (await res.json().catch(() => ({}))) as ImagesResponse;
    const item = json.data?.[0];
    if (item?.b64_json) {
      const image = Buffer.from(item.b64_json, "base64");
      if (!image.length) throw new ProviderError("apiz.image returned an empty image", undefined, false, "invalid");
      return { image, mime: item.mime_type ?? "image/png", costUsd: this.o.usdPerImage };
    }
    if (!item?.url) throw new ProviderError("apiz.image returned no image (no url and no b64_json)", undefined, false, "invalid");

    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      throw new ProviderError("apiz.image returned an invalid image url", undefined, false, "invalid");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ProviderError(`apiz.image returned an unsupported url scheme (${url.protocol})`, undefined, false, "invalid");
    }
    // The key is deliberately NOT sent: the image lives on another host (a CDN link).
    const dl = await fetchWithRetry(url.toString(), {}, { label: "apiz.download", retries: 3, timeoutMs: 120_000 });
    const image = Buffer.from(await dl.arrayBuffer());
    if (!image.length) throw new ProviderError("apiz.download returned an empty file", undefined, false, "invalid");
    const ct = dl.headers.get("content-type") ?? "";
    return { image, mime: item.mime_type ?? (ct.startsWith("image/") ? ct.split(";")[0] : "image/png"), costUsd: this.o.usdPerImage };
  }
}
