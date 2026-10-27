/** Captions (spec 10): SRT and ASS from one cue list, timed to the narration audio. */
import type { Timeline } from "./timeline";

export interface CaptionStyle {
  font: string;
  size: number;
  bold: boolean;
  outline: number;
  marginV: number;
  maxCharsPerLine: number;
  maxLines: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: "Inter",
  size: 54,
  bold: true,
  outline: 3,
  marginV: 60,
  maxCharsPerLine: 42,
  maxLines: 2,
};

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

const CUE_TAIL = 0.15;

/** Greedy word wrap into lines of at most maxChars (a single long word is kept whole). */
export function wrapWords(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Split one narration into pieces that each fit maxLines x maxChars. */
export function splitForCaptions(text: string, style: Pick<CaptionStyle, "maxCharsPerLine" | "maxLines">): string[][] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = wrapWords(words, style.maxCharsPerLine);
  const pieces: string[][] = [];
  for (let i = 0; i < lines.length; i += style.maxLines) pieces.push(lines.slice(i, i + style.maxLines));
  return pieces;
}

export function buildCues(
  tl: Timeline,
  narrations: string[],
  style: CaptionStyle = DEFAULT_CAPTION_STYLE,
): Cue[] {
  if (narrations.length !== tl.scenes.length) throw new Error("narrations length must match the timeline");
  const cues: Cue[] = [];
  tl.scenes.forEach((sc, i) => {
    const pieces = splitForCaptions(narrations[i], style);
    const weights = pieces.map((p) => p.join(" ").length);
    const totalW = weights.reduce((a, b) => a + b, 0) || 1;
    let t = sc.speechStartSec;
    pieces.forEach((lines, k) => {
      const dur = (weights[k] / totalW) * sc.audioSec;
      const start = t;
      const end = k === pieces.length - 1 ? sc.speechEndSec + CUE_TAIL : t + dur;
      cues.push({ start, end, lines });
      t += dur;
    });
  });
  // Clamp: no overlaps, inside [0, total].
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (next && cues[i].end > next.start - 0.001) cues[i].end = Math.max(cues[i].start + 0.05, next.start - 0.001);
    cues[i].start = Math.max(0, cues[i].start);
    cues[i].end = Math.min(tl.totalSec, cues[i].end);
  }
  return cues;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

export function formatSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.lines.join("\n")}`)
      .join("\n\n") + "\n"
  );
}

export function formatAssTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs % 100, 2)}`;
}

function escapeAss(s: string): string {
  return s.replace(/\\/g, "＼").replace(/\{/g, "(").replace(/\}/g, ")");
}

export function toAss(cues: Cue[], style: CaptionStyle = DEFAULT_CAPTION_STYLE): string {
  const bold = style.bold ? -1 : 0;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${style.font},${style.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${bold},0,0,0,100,100,0,0,1,${style.outline},0,2,80,80,${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map(
    (c) =>
      `Dialogue: 0,${formatAssTime(c.start)},${formatAssTime(c.end)},Default,,0,0,0,,${c.lines.map(escapeAss).join("\\N")}`,
  );
  return [...header, ...events, ""].join("\n");
}
