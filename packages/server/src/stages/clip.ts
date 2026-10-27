import sharp from "sharp";
import { cacheKeyOf } from "../assets";
import { projectKey } from "../storage";
import { markDownstreamStale } from "../stale";
import { fatal, loadProject, loadScene, readAsset, saveScene, type StageFn } from "./common";

/** One short motion instruction per scene (spec 6.6): the picture does the rest. */
export function motionInstruction(visual: string): string {
  const v = visual.toLowerCase();
  if (/fire|flame|candle|torch|lantern/.test(v)) return "flames flicker softly, camera holds";
  if (/rain|storm/.test(v)) return "rain falls steadily, camera holds";
  if (/water|river|sea|ocean|wave/.test(v)) return "water ripples gently, camera holds";
  if (/clock|watch|hands/.test(v)) return "clock hands move slowly, camera holds";
  if (/smoke|mist|fog|cloud/.test(v)) return "mist drifts slowly, camera holds";
  return "gentle ambient movement, camera holds";
}

/** AI clip (optional, capped). Any failure falls back to Ken Burns for that scene. */
export const clipStage: StageFn = async (ctx, data) => {
  if (!data.sceneId) throw fatal("clip job needs a sceneId");
  const project = await loadProject(ctx, data.projectId);
  const scene = await loadScene(ctx, data.sceneId);

  const fallback = async (why: string) => {
    scene.motion = "kenburns";
    scene.clipAssetId = null;
    await saveScene(ctx, scene);
    await markDownstreamStale(ctx, project, scene.id, "clip");
    return { costUsd: 0, note: `fell back to Ken Burns: ${why}` };
  };

  if (!ctx.providers.video || project.settings.maxAiClipShare <= 0) return fallback("AI clips are disabled");
  const img = await readAsset(ctx, scene.imageAssetId);
  if (!img) return fallback("the scene has no image");

  const seconds = ctx.cfg.providers.video.clipSeconds;
  const prompt = `${scene.visual}. ${motionInstruction(scene.visual)}.`;
  const gen = scene.gen?.clip ?? 0;
  const cacheKey = cacheKeyOf({
    provider: ctx.providers.video.id, model: ctx.providers.video.model, prompt, refsHash: img.asset.id, params: { seconds, gen },
  });

  try {
    let asset = await ctx.assets.findByCacheKey(project.id, cacheKey);
    let cost = 0;
    if (!asset) {
      const upload = await sharp(img.data).resize(1920, 1080, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer();
      const res = await ctx.providers.video.generate({ image: upload, imageMime: "image/jpeg", prompt, seconds });
      cost = res.costUsd;
      const storageKey = projectKey(project.id, "clips", `s${String(scene.idx + 1).padStart(4, "0")}-${cacheKey.slice(0, 8)}.mp4`);
      const bytes = await ctx.storage.put(storageKey, res.video);
      asset = await ctx.assets.create({
        projectId: project.id, sceneId: scene.id, type: "clip", storageKey, mime: "video/mp4",
        provider: ctx.providers.video.id, model: ctx.providers.video.model, params: { seconds, gen },
        cacheKey, costUsd: cost, durationSec: res.seconds, bytes,
      });
    }
    scene.clipAssetId = asset.id;
    scene.errors = { ...scene.errors, clip: undefined };
    await saveScene(ctx, scene);
    await markDownstreamStale(ctx, project, scene.id, "clip");
    await ctx.events.publish(project.id, "asset", { kind: "clip", sceneId: scene.id, assetId: asset.id });
    return { costUsd: cost };
  } catch (e) {
    return fallback((e as Error).message.slice(0, 200));
  }
};
