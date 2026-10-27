/** YouTube chapters from beats (spec 12). */
import type { Timeline } from "./timeline";

export interface Chapter {
  title: string;
  startSec: number;
}

export function formatChapterTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export interface ChapterResult {
  chapters: Chapter[];
  warnings: string[];
}

export const MIN_CHAPTER_SEC = 10;
export const MIN_CHAPTERS = 3;

/** Chapter timestamp = the beat's first scene speech start; the first chapter is forced to 0:00. */
export function buildChapters(tl: Timeline): ChapterResult {
  const chapters: Chapter[] = [];
  let lastBeat: string | null = null;
  for (const sc of tl.scenes) {
    if (sc.beat !== lastBeat) {
      chapters.push({ title: sc.beat, startSec: sc.speechStartSec });
      lastBeat = sc.beat;
    }
  }
  if (chapters.length) chapters[0].startSec = 0;

  const warnings: string[] = [];
  if (chapters.length < MIN_CHAPTERS) {
    warnings.push(`Only ${chapters.length} chapter(s); YouTube needs at least ${MIN_CHAPTERS} to show chapters.`);
  }
  chapters.forEach((c, i) => {
    const end = chapters[i + 1]?.startSec ?? tl.totalSec;
    if (end - c.startSec < MIN_CHAPTER_SEC) {
      warnings.push(`Chapter "${c.title}" is shorter than ${MIN_CHAPTER_SEC}s; YouTube may ignore chapters.`);
    }
  });
  return { chapters, warnings };
}

export function chaptersToText(chapters: Chapter[]): string {
  return chapters.map((c) => `${formatChapterTime(c.startSec)} ${c.title}`).join("\n");
}
