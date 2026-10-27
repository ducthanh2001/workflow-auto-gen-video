/** Script parser (spec 2.1 and 6.1). */
import matter from "gray-matter";
import { z } from "zod";

export const MAX_SCRIPT_BYTES = 200 * 1024;
export const MIN_WORDS = 100;

export const ScriptMeta = z.object({
  title: z.string().min(1),
  language: z.string().default("en"),
  voice: z.string().default("narrator_calm"),
  style: z.string().default("stickman-hero"),
  target_minutes: z.number().positive().optional(),
  sources: z.array(z.string()).default([]),
});
export type ScriptMeta = z.infer<typeof ScriptMeta>;

export interface Beat {
  title: string;
  paragraphs: string[];
}

export interface ParsedScript {
  meta: ScriptMeta;
  beats: Beat[];
  /** all narration in order, paragraphs joined by a single space */
  narration: string;
  wordCount: number;
  warnings: string[];
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

/** Normalize whitespace and typographic quotes; keeps paragraph breaks. */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[   ]/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function countWords(s: string): number {
  const m = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

export function parseScript(raw: string): ParsedScript {
  if (Buffer.byteLength(raw, "utf8") > MAX_SCRIPT_BYTES) {
    throw new ScriptError(`Script is larger than ${MAX_SCRIPT_BYTES / 1024} KB`);
  }
  let fm: matter.GrayMatterFile<string>;
  try {
    // Pass an options object so gray-matter does not cache by content.
    fm = matter(raw, {});
  } catch (e) {
    throw new ScriptError(`Invalid front matter: ${(e as Error).message}`);
  }
  const metaResult = ScriptMeta.safeParse(fm.data);
  if (!metaResult.success) {
    const issues = metaResult.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ScriptError(`Invalid front matter: ${issues.join("; ")}`);
  }
  const meta = metaResult.data;
  if (meta.language !== "en") {
    throw new ScriptError(`Only English narration is supported in v1 (got "${meta.language}")`);
  }

  const body = normalizeText(fm.content);
  const beats: Beat[] = [];
  let current: Beat | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length && current) current.paragraphs.push(paragraph.join(" ").trim());
    paragraph = [];
  };

  for (const line of body.split("\n")) {
    const h = /^##\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      flushParagraph();
      current = { title: h[1].trim(), paragraphs: [] };
      beats.push(current);
      continue;
    }
    if (/^#\s/.test(line)) continue; // top-level heading: not narrated, not a beat
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    if (!current) {
      current = { title: "Intro", paragraphs: [] };
      beats.push(current);
    }
    paragraph.push(line.trim());
  }
  flushParagraph();

  const kept = beats.filter((b) => b.paragraphs.length > 0);
  const narration = kept.flatMap((b) => b.paragraphs).join(" ");
  const wordCount = countWords(narration);
  if (wordCount < MIN_WORDS) {
    throw new ScriptError(`Script has ${wordCount} words; at least ${MIN_WORDS} are required`);
  }

  const warnings: string[] = [];
  if (meta.sources.length === 0) {
    warnings.push("No `sources` listed in the front matter. Factual scripts should cite sources.");
  }
  if (kept.length < 3) {
    warnings.push("Fewer than 3 beats: YouTube chapters need at least 3.");
  }
  if (meta.target_minutes) {
    const est = wordCount / 190;
    if (Math.abs(est - meta.target_minutes) / meta.target_minutes > 0.25) {
      warnings.push(
        `Estimated length is ${est.toFixed(1)} min at ~190 wpm; target_minutes is ${meta.target_minutes}.`,
      );
    }
  }
  return { meta, beats: kept, narration, wordCount, warnings };
}
