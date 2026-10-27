import path from "node:path";
import { Asset } from "../entities";
import { buildImagePrompt, composeThumbnail, fallbackThumbConcepts, fitTo16x9, generateThumbConcepts, type ThumbConcept } from "@vp/core";
import { cacheKeyOf, hashBuffers } from "../assets";
import { projectKey } from "../storage";
import { fatal, loadProject, loadScenes, readAsset, type StageFn } from "./common";

/** Thumbnails (spec 11): background art from Gemini (no text), text drawn by code. */
export const thumbStage: StageFn = async (ctx, data) => {
  const project = await loadProject(ctx, data.projectId);
  const style = ctx.cfg.styles[project.settings.style];
  if (!style) throw fatal(`unknown style "${project.settings.style}"`);
  const sheet = await readAsset(ctx, project.characterSheetAssetId);
  const anchor = await readAsset(ctx, project.styleAnchorAssetId);
  const refs = [sheet, anchor].filter((x): x is NonNullable<typeof x> => !!x).map((r) => ({ mime: r.asset.mime ?? "image/jpeg", data: r.data }));

  const scenes = await loadScenes(ctx, project.id);
  const narration = scenes.map((s) => s.narration).join(" ");
  let concepts: ThumbConcept[];
  let llmCost = 0;
  try {
    ({ concepts, costUsd: llmCost } = await generateThumbConcepts(ctx.providers.llm, { title: project.title, narrationExcerpt: narration }));
  } catch (e) {
    // no API key / no credit / bad answer: use generic concepts built from the title
    ctx.log("thumbnail concepts: using the fallback", { projectId: project.id, reason: (e as Error).message.slice(0, 160) });
    concepts = fallbackThumbConcepts(project.title);
  }

  const gen = project.meta.thumbGen ?? 0;
  const fontPath = path.join(ctx.cfg.fontsDir, "Anton-Regular.ttf");
  const repo = ctx.ds.getRepository(Asset);
  const old = (await repo.find({ where: { projectId: project.id, type: "thumbnail" } }));
  let cost = llmCost;

  for (const [i, concept] of concepts.slice(0, 3).entries()) {
    const variant = "ABC"[i];
    const prompt = [
      buildImagePrompt({ style, visual: concept.background, shot: "wide" }),
      "Composition: one clear focal subject, strong contrast, and a large calm, uncluttered area on one side where text will be added later.",
    ].join("\n");
    const cacheKey = cacheKeyOf({
      provider: ctx.providers.image.id, model: ctx.providers.image.model, prompt,
      refsHash: hashBuffers(...refs.map((r) => r.data.subarray(0, 64))), params: { thumb: variant, text: concept.text, gen },
    });
    if (await ctx.assets.findByCacheKey(project.id, cacheKey)) continue;

    const res = await ctx.providers.image.generate({ prompt, refs, aspect: "16:9" });
    cost += res.costUsd;
    const bg = await fitTo16x9(res.image, 1920, 1080);
    const composed = await composeThumbnail({ background: bg, text: concept.text, fontPath });
    const storageKey = projectKey(project.id, "out", `thumbnail_${variant}.jpg`);
    const bytes = await ctx.storage.put(storageKey, composed.jpg);
    await ctx.storage.put(projectKey(project.id, "out", `thumbnail_${variant}_small.jpg`), composed.smallPreview);

    for (const o of old) if (o.params.variant === variant) await repo.delete({ id: o.id });
    await ctx.assets.create({
      projectId: project.id, type: "thumbnail", storageKey, mime: "image/jpeg",
      provider: ctx.providers.image.id, model: ctx.providers.image.model,
      params: { variant, text: concept.text, concept: concept.name, check: composed.check },
      cacheKey, costUsd: res.costUsd, bytes,
    });
    await ctx.events.publish(project.id, "asset", { kind: "thumbnail", variant });
  }
  return { costUsd: cost };
};
