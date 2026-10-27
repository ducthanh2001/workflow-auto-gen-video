import { buildChapters, buildMetadata, buildTimeline, fallbackDraft, generateMetadataDraft, type MetadataDraft } from "@vp/core";
import { Asset } from "../entities";
import { projectKey } from "../storage";
import { fatal, loadProject, loadScenes, type StageFn } from "./common";
import { writeReport } from "./report";

/** metadata.md (spec 12): titles, description with chapters, sources, disclosure, tags. */
export const metadataStage: StageFn = async (ctx, data) => {
  const project = await loadProject(ctx, data.projectId);
  const scenes = await loadScenes(ctx, project.id);
  if (!scenes.length || scenes.some((s) => !s.audioDurationSec)) throw fatal("metadata needs voiced scenes");

  const tcfg = ctx.cfg.providers.timeline;
  const timeline = buildTimeline(
    scenes.map((s) => ({ beat: s.beat, audioSec: s.audioDurationSec!, transitionOut: s.transitionOut })),
    { fps: project.settings.fps, lead: tcfg.lead, tail: tcfg.tail, tailBeat: tcfg.tailBeat, transition: project.settings.transitionSec },
  );
  const { chapters, warnings: chapterWarnings } = buildChapters(timeline);

  const narration = scenes.map((s) => s.narration).join(" ");
  let draft: MetadataDraft;
  let cost = 0;
  try {
    const r = await generateMetadataDraft(ctx.providers.llm, { title: project.title, narration });
    draft = r.draft;
    cost = r.costUsd;
  } catch {
    draft = fallbackDraft(project.title, narration);
  }
  const m = buildMetadata({ title: project.title, draft, chapters, sources: project.meta.sources ?? [] });
  const warnings = [...m.warnings, ...chapterWarnings];
  const markdown = warnings.length && !m.markdown.includes("## Warnings")
    ? m.markdown + "\n## Warnings\n" + warnings.map((w) => `- ${w}`).join("\n") + "\n"
    : m.markdown;

  const repo = ctx.ds.getRepository(Asset);
  for (const a of await repo.find({ where: { projectId: project.id, type: "doc" } })) if (a.params.kind === "metadata") await repo.delete({ id: a.id });
  const key = projectKey(project.id, "out", "metadata.md");
  const bytes = await ctx.storage.put(key, Buffer.from(markdown, "utf8"));
  await ctx.assets.create({ projectId: project.id, type: "doc", storageKey: key, mime: "text/markdown", params: { kind: "metadata", titles: m.titles, tags: m.tags, warnings }, bytes });

  await writeReport(ctx, project.id);
  await ctx.events.publish(project.id, "asset", { kind: "metadata" });
  return { costUsd: cost };
};
