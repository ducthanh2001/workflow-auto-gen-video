/** YouTube metadata (spec 12). */
import { z } from "zod";
import type { LlmClient } from "./planner";
import { extractJson } from "./planner";
import { chaptersToText, type Chapter } from "./chapters";

export const METADATA_MARKER = "YOUTUBE_METADATA";
export const MAX_TITLE = 70;

export const MetadataDraft = z.object({
  titleAlternatives: z.array(z.string()).min(1),
  hookLines: z.array(z.string()).min(1),
  tags: z.array(z.string()).min(1),
});
export type MetadataDraft = z.infer<typeof MetadataDraft>;

export const METADATA_SYSTEM = `${METADATA_MARKER}: you write YouTube metadata for an educational video.
Reply with ONE JSON object only: {"titleAlternatives":["...","..."],"hookLines":["...","..."],"tags":["..."]}.
Rules: 2 alternative titles, each at most ${MAX_TITLE} characters and truthful to the video (no promise it does not deliver);
exactly 2 hook lines for the top of the description (one sentence each, no spoilers beyond the video, no emojis);
8 to 12 tags (short, lowercase, no # sign).`;

export async function generateMetadataDraft(
  llm: LlmClient,
  input: { title: string; narration: string },
): Promise<{ draft: MetadataDraft; costUsd: number }> {
  const res = await llm.complete({
    system: METADATA_SYSTEM,
    user: `Title: ${input.title}\n\nScript:\n${input.narration.slice(0, 12000)}`,
    maxTokens: 1500,
  });
  return { draft: MetadataDraft.parse(extractJson(res.text)), costUsd: res.costUsd ?? 0 };
}

/** Used when no LLM is available or its output is unusable. */
export function fallbackDraft(title: string, narration: string): MetadataDraft {
  const sentences = narration.match(/[^.!?]+[.!?]/g)?.map((s) => s.trim()) ?? [];
  const words = Array.from(new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3)));
  return {
    titleAlternatives: [],
    hookLines: [sentences[0] ?? title, sentences[1] ?? "Here is what the research actually says."],
    tags: [...words, "explained", "science", "education", "documentary"].slice(0, 12),
  };
}

export const DISCLOSURE_LINES = [
  "Educational content, not medical advice.",
  "This video was made with AI assistance: the narration voice and the illustrations are synthetic.",
];

export interface MetadataInput {
  title: string;
  draft: MetadataDraft;
  chapters: Chapter[];
  sources: string[];
}

export interface MetadataResult {
  markdown: string;
  titles: string[];
  tags: string[];
  description: string;
  warnings: string[];
}

function cleanTag(t: string): string {
  return t.replace(/^#/, "").trim().toLowerCase().slice(0, 30);
}

export function buildMetadata(i: MetadataInput): MetadataResult {
  const warnings: string[] = [];
  const titles = [i.title, ...i.draft.titleAlternatives]
    .map((t) => t.trim())
    .filter((t, idx, a) => t && a.indexOf(t) === idx)
    .slice(0, 3);
  titles.forEach((t, idx) => {
    if (t.length > MAX_TITLE) {
      if (idx === 0) warnings.push(`The script title is ${t.length} characters; YouTube titles should be at most ${MAX_TITLE}.`);
    }
  });
  const okTitles = titles.filter((t, idx) => idx === 0 || t.length <= MAX_TITLE);
  if (okTitles.length < 3) warnings.push(`Only ${okTitles.length} title option(s) available.`);

  let tags = Array.from(new Set(i.draft.tags.map(cleanTag).filter(Boolean)));
  // YouTube allows ~500 characters of tags in total.
  let total = 0;
  tags = tags.filter((t) => (total += t.length + 1) <= 480).slice(0, 12);
  if (tags.length < 8) warnings.push(`Only ${tags.length} tags (recommended 8 to 12).`);

  const hook = i.draft.hookLines.slice(0, 2).join("\n");
  const description = [
    hook,
    "",
    "Chapters",
    chaptersToText(i.chapters),
    "",
    i.sources.length ? "Sources\n" + i.sources.join("\n") : "Sources\n(none listed)",
    "",
    DISCLOSURE_LINES.join("\n"),
  ].join("\n");
  if (!i.sources.length) warnings.push("No sources listed in the description.");

  const markdown = [
    `# YouTube metadata`,
    "",
    "## Title options",
    ...okTitles.map((t, n) => `${n + 1}. ${t}  _(${t.length} chars)_`),
    "",
    "## Description",
    "```",
    description,
    "```",
    "",
    "## Tags",
    tags.join(", "),
    "",
    "## Before you publish",
    "- In YouTube Studio, set the altered/synthetic content disclosure if it applies to this video.",
    "- Check every source link and the music license note.",
    ...(warnings.length ? ["", "## Warnings", ...warnings.map((w) => `- ${w}`)] : []),
    "",
  ].join("\n");
  return { markdown, titles: okTitles, tags, description, warnings };
}
