/** Thumbnail generator (spec 11): concepts from an LLM, text drawn by code, quality checks. */
import sharp from "sharp";
import { z } from "zod";
import * as opentype from "opentype.js";
import { promises as fs } from "node:fs";
import type { LlmClient } from "./planner";
import { extractJson } from "./planner";
import { checkVisualPrompt } from "./safety";

export const THUMB_W = 1280;
export const THUMB_H = 720;
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;
export const THUMB_CONCEPT_MARKER = "THUMBNAIL_CONCEPTS";

export const ThumbConcept = z.object({
  name: z.string().min(1),
  /** background art description: one focal subject, no text, no real people */
  background: z.string().min(10),
  /** overlay text, at most 4 words */
  text: z.string().min(1),
});
export type ThumbConcept = z.infer<typeof ThumbConcept>;
export const ThumbConcepts = z.object({ concepts: z.array(ThumbConcept).min(3) });

export const THUMB_SYSTEM = `${THUMB_CONCEPT_MARKER}: you propose 3 distinct YouTube thumbnail concepts for an educational video.
Reply with ONE JSON object only: {"concepts":[{"name":"...","background":"...","text":"..."}]}.
Rules: exactly 3 concepts; one focal subject each; strong contrast; large negative space on one side for text;
"background" describes the picture only (no text, letters, numbers or logos; no real people; no gore or graphic bodies);
"text" is at most 4 words, curiosity-driven but truthful to the video; never copy any existing channel's thumbnails.`;

export function limitWords(text: string, max = 4): string {
  return text.trim().split(/\s+/).slice(0, max).join(" ").toUpperCase();
}

export async function generateThumbConcepts(
  llm: LlmClient,
  input: { title: string; narrationExcerpt: string },
): Promise<{ concepts: ThumbConcept[]; costUsd: number }> {
  const res = await llm.complete({
    system: THUMB_SYSTEM,
    user: `Title: ${input.title}\n\nScript excerpt:\n${input.narrationExcerpt.slice(0, 3000)}`,
    maxTokens: 2000,
  });
  const parsed = ThumbConcepts.parse(extractJson(res.text));
  const concepts = parsed.concepts.slice(0, 3).map((c) => {
    const safe = checkVisualPrompt(c.background);
    return {
      ...c,
      text: limitWords(c.text),
      background: safe.ok ? c.background : "A single glowing candle on a dark blue table, warm light against deep blue night",
    };
  });
  return { concepts, costUsd: res.costUsd ?? 0 };
}

// ---------------------------------------------------------------- composition

export interface ThumbCheck {
  contrast: number;
  textWidthRatio: number;
  /** nothing but background in the duration-badge corner */
  badgeCornerClear: boolean;
  /** font px when the thumbnail is shown at 168x94 */
  smallFontPx: number;
  bytes: number;
  warnings: string[];
}

export interface ThumbResult {
  jpg: Buffer;
  smallPreview: Buffer;
  check: ThumbCheck;
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function relLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Split into at most two balanced lines. */
function layoutLines(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return words.length === 2 ? [words.join(" ")] : words;
  let best = [words.join(" ")];
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [a, b];
    }
  }
  return best;
}

export interface ComposeOptions {
  background: Buffer;
  text: string;
  fontPath: string;
  maxWidthRatio?: number;
}

export async function composeThumbnail(opts: ComposeOptions): Promise<ThumbResult> {
  const maxW = (opts.maxWidthRatio ?? 0.35) * THUMB_W;
  const fontBuf = await fs.readFile(opts.fontPath);
  const font = opentype.parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength) as ArrayBuffer);
  const text = limitWords(opts.text);
  const lines = layoutLines(text);

  // Largest font size that keeps every line within maxW and the block within 40% of the height.
  const widthAt = (size: number) => Math.max(...lines.map((l) => font.getAdvanceWidth(l, size)));
  let size = 170;
  while (size > 40 && (widthAt(size) > maxW || size * 1.1 * lines.length > THUMB_H * 0.4)) size -= 2;
  const lineH = size * 1.08;
  const blockW = widthAt(size);
  const blockH = lineH * lines.length;
  const pad = 22;

  const bg = await sharp(opts.background).resize(THUMB_W, THUMB_H, { fit: "cover" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const px = bg.data;

  // Candidate boxes: everything but the bottom-right duration badge area.
  const margin = 56;
  const cands: Box[] = [
    { x: margin, y: THUMB_H / 2 - blockH / 2, w: blockW, h: blockH },
    { x: margin, y: margin, w: blockW, h: blockH },
    { x: margin, y: THUMB_H - margin - blockH - 20, w: blockW, h: blockH },
    { x: THUMB_W - margin - blockW, y: THUMB_H / 2 - blockH / 2 - 40, w: blockW, h: blockH },
    { x: THUMB_W - margin - blockW, y: margin, w: blockW, h: blockH },
  ];

  const sample = (b: Box) => {
    const lums: number[] = [];
    const x0 = Math.max(0, Math.floor(b.x - pad)), x1 = Math.min(THUMB_W, Math.ceil(b.x + b.w + pad));
    const y0 = Math.max(0, Math.floor(b.y - pad)), y1 = Math.min(THUMB_H, Math.ceil(b.y + b.h + pad));
    for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) {
      const o = (y * THUMB_W + x) * 3;
      lums.push(relLuminance(px[o], px[o + 1], px[o + 2]));
    }
    lums.sort((a, b) => a - b);
    const mean = lums.reduce((a, v) => a + v, 0) / lums.length;
    const p90 = lums[Math.floor(lums.length * 0.9)];
    const variance = lums.reduce((a, v) => a + (v - mean) ** 2, 0) / lums.length;
    return { mean, p90, std: Math.sqrt(variance) };
  };

  // Pick the quietest (low-variance), darkest region.
  const scored = cands.map((box) => ({ box, s: sample(box) })).sort((a, b) => a.s.std + a.s.p90 - (b.s.std + b.s.p90));
  const { box, s } = scored[0];

  // White text; if p90 of the region is too bright, darken it with a scrim until contrast >= 7:1.
  // White needs a background luminance <= 1.05/7 - 0.05 = 0.1 for 7:1; aim a little under that.
  // (Blending black in sRGB space darkens more than this linear estimate, so it is conservative.)
  const targetL = 0.09;
  let alpha = 0;
  if (s.p90 > targetL) alpha = Math.min(0.92, Math.ceil((1 - targetL / s.p90) * 100) / 100);
  const effective = s.p90 * (1 - alpha);
  const contrast = contrastRatio(1, effective);

  // Text as outlines (no font lookup at render time, so output is identical everywhere).
  const paths = lines.map((l, i) => {
    const x = box.x + (blockW - font.getAdvanceWidth(l, size)) / 2;
    const y = box.y + size * 0.9 + i * lineH;
    return font.getPath(l, x, y, size).toPathData(2);
  });
  const stroke = Math.max(6, size * 0.09);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_W}" height="${THUMB_H}">
${alpha > 0 ? `<rect x="${box.x - pad}" y="${box.y - pad}" width="${box.w + pad * 2}" height="${box.h + pad * 2}" rx="18" fill="#000" fill-opacity="${alpha}"/>` : ""}
${paths.map((d) => `<path d="${d}" fill="#111" stroke="#111" stroke-width="${stroke}" stroke-linejoin="round"/>`).join("\n")}
${paths.map((d) => `<path d="${d}" fill="#fff"/>`).join("\n")}
</svg>`;

  const composed = sharp(opts.background).resize(THUMB_W, THUMB_H, { fit: "cover" }).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  let quality = 90;
  let jpg = await composed.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
  while (jpg.length > THUMB_MAX_BYTES && quality > 50) {
    quality -= 5;
    jpg = await composed.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  const smallPreview = await sharp(jpg).resize(168, 94).jpeg({ quality: 85 }).toBuffer();

  const badge: Box = { x: THUMB_W - 220, y: THUMB_H - 120, w: 220, h: 120 };
  const overlapsBadge = !(box.x + box.w < badge.x || box.x > badge.x + badge.w || box.y + box.h < badge.y || box.y > badge.y + badge.h);

  const warnings: string[] = [];
  const widthRatio = blockW / THUMB_W;
  const smallFontPx = size * (168 / THUMB_W);
  if (contrast < 7) warnings.push(`contrast ${contrast.toFixed(1)}:1 is below 7:1`);
  if (widthRatio > 0.35 + 1e-6) warnings.push(`text is ${(widthRatio * 100).toFixed(0)}% of the width (max 35%)`);
  if (overlapsBadge) warnings.push("text overlaps the duration badge corner");
  if (smallFontPx < 9) warnings.push(`text is ${smallFontPx.toFixed(1)}px at 168x94; may be unreadable small`);
  if (jpg.length > THUMB_MAX_BYTES) warnings.push("JPG is over 2 MB");

  return {
    jpg,
    smallPreview,
    check: { contrast, textWidthRatio: widthRatio, badgeCornerClear: !overlapsBadge, smallFontPx, bytes: jpg.length, warnings },
  };
}

/** Used when no LLM is available: generic, truthful concepts built from the title. */
export function fallbackThumbConcepts(title: string): ThumbConcept[] {
  const words = title.replace(/[?!.:,]/g, "").split(/\s+/).filter(Boolean);
  const head = limitWords(words.slice(0, 4).join(" "));
  const tail = limitWords(words.slice(-3).join(" "));
  return [
    { name: "Candle", background: "A single glowing candle on a dark blue table, large empty space on the right, warm light against deep blue night", text: head },
    { name: "Clock", background: "A round clock on a stone wall in warm lamp light, empty dark space on the left, strong warm and cool contrast", text: tail },
    { name: "Doorway", background: "A small round-headed figure standing at an open doorway of blue light, empty space on the right", text: "EXPLAINED" },
  ];
}
