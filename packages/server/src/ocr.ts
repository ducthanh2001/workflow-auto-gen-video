/** Optional OCR pass (spec 6.5): detect text that slipped into a generated image. */
import path from "node:path";
import sharp from "sharp";

type Worker = { recognize(img: Buffer): Promise<{ data: { text: string; confidence: number } }> };
let worker: Promise<Worker> | null = null;

async function getWorker(cachePath: string): Promise<Worker> {
  if (!worker) {
    worker = (async () => {
      const { createWorker } = await import("tesseract.js");
      return (await createWorker("eng", 1, { cachePath: path.resolve(cachePath) })) as unknown as Worker;
    })();
  }
  return worker;
}

export interface OcrResult {
  hasText: boolean;
  sample: string;
}

/** Everything the OCR can read from the picture, with its confidence (0-100). */
export async function recognizeText(image: Buffer, cachePath: string): Promise<{ text: string; confidence: number }> {
  const small = await sharp(image).resize(1280, 720, { fit: "inside" }).greyscale().normalise().png().toBuffer();
  const w = await getWorker(cachePath);
  const { data } = await w.recognize(small);
  return { text: data.text, confidence: data.confidence };
}

/** True when the image contains readable words (3+ letters). Conservative on purpose: false alarms only cost one regeneration. */
export async function detectText(image: Buffer, cachePath: string): Promise<OcrResult> {
  const data = await recognizeText(image, cachePath);
  const words = (data.text.match(/[A-Za-z]{3,}/g) ?? []).filter((t) => /[aeiouAEIOU]/.test(t));
  const hasText = words.length >= 1 && data.confidence >= 55;
  return { hasText, sample: words.slice(0, 5).join(" ") };
}
