/**
 * On-screen text (spec 9.1). Text is drawn to a transparent PNG with sharp, from glyph outlines,
 * then overlaid with a short fade. `drawtext` is never used with user text (escaping risks).
 */
import { promises as fs } from "node:fs";
import sharp from "sharp";
import * as opentype from "opentype.js";

export interface OverlayOptions {
  text: string;
  fontPath: string;
  width: number;
  height: number;
}

/** Strip control characters; the planner caps the text at 40 characters. */
export function cleanOverlayText(t: string): string {
  return t.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

export async function renderTextOverlay(o: OverlayOptions): Promise<Buffer> {
  const text = cleanOverlayText(o.text);
  const fontBuf = await fs.readFile(o.fontPath);
  const font = opentype.parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength) as ArrayBuffer);

  const maxW = o.width * 0.5;
  let size = Math.round(o.height * 0.075);
  while (size > 24 && font.getAdvanceWidth(text, size) > maxW) size -= 2;
  const x = Math.round(o.width * 0.05);
  const y = Math.round(o.height * 0.06) + size;
  const d = font.getPath(text, x, y, size).toPathData(2);
  const stroke = Math.max(4, size * 0.08);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}">
<path d="${d}" fill="#111" stroke="#111" stroke-width="${stroke}" stroke-linejoin="round"/>
<path d="${d}" fill="#fff"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** filter_complex fragment: input 1 is the looped overlay PNG; produces [ov]. */
export function overlayFilter(frames: number, fps: number): string {
  const len = frames / fps;
  const outStart = Math.max(0.8, len - 0.8);
  return `[1:v]format=rgba,fade=t=in:st=0.3:d=0.4:alpha=1,fade=t=out:st=${Number(outStart.toFixed(3))}:d=0.4:alpha=1[ov]`;
}
