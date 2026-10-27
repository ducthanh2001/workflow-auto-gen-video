import sharp from "sharp";
import { CHARACTER_LOCK_VERSION, SCENE_STYLE_VERSION } from "@vp/shared";
import {
  ProviderError, buildImagePrompt, checkImageQuality, checkVisualPrompt, fitTo16x9, heroSheetKind, chooseRefs, labelsMatch, mentionsNamedPerson, sceneHasPeople,
} from "@vp/core";
import { cacheKeyOf, hashBuffers } from "../assets";
import { projectKey } from "../storage";
import { detectText, recognizeText } from "../ocr";
import { markDownstreamStale } from "../stale";
import { fatal, loadProject, loadScene, readAsset, saveScene, type StageFn } from "./common";

/** Images (spec 6.5): Gemini image with character sheet + style anchor refs, upscaled to 3840x2160. */
export const imageStage: StageFn = async (ctx, data) => {
  if (!data.sceneId) throw fatal("image job needs a sceneId");
  const project = await loadProject(ctx, data.projectId);
  const scene = await loadScene(ctx, data.sceneId);
  const style = ctx.cfg.styles[project.settings.style];
  if (!style) throw fatal(`unknown style "${project.settings.style}"`);

  const characters = scene.characters;
  const safety = checkVisualPrompt(
    [scene.visual, ...(scene.imageText ?? []), ...(characters ?? []).flatMap((c) => [c.hair, c.outfit, c.props, c.expression, c.pose])].filter(Boolean).join(" "),
  );
  if (!safety.ok) {
    throw fatal(`Blocked by the content filter (${safety.reasons.join(", ")}). Edit the visual to use symbolic imagery and retry.`);
  }
  if (mentionsNamedPerson(scene.visual)) {
    throw fatal("The visual seems to name a real person. Describe a generic figure instead and retry.");
  }

  // a hero in a shirt, hoodie, jacket or suit uses the modern sheet when the project has one
  const modernId = project.meta.characterSheetModernAssetId;
  const wantsModern = style.shared_lock && heroSheetKind(characters) === "modern" && !!modernId;
  const sheet = await readAsset(ctx, wantsModern ? modernId : project.characterSheetAssetId);
  const anchor = await readAsset(ctx, project.styleAnchorAssetId);
  if (!sheet || !anchor) throw fatal("References are not approved yet: pick a style anchor first");
  // what the service takes: sheet + style sample, or one picture (the style sample, which also shows the hero)
  const picked = chooseRefs(ctx.providers.image, characters, {
    sheet: { mime: sheet.asset.mime ?? "image/jpeg", data: sheet.data },
    anchor: { mime: anchor.asset.mime ?? "image/jpeg", data: anchor.data },
  });
  const refs = picked.refs;
  const withSheet = picked.sheet;

  const gen = scene.gen?.image ?? 0;
  const labels = scene.imageText ?? [];
  // the prompt only talks about the pictures that are really attached
  const promptBase = { style, visual: scene.visual, shot: scene.shot, characters, imageText: labels, lighting: scene.lighting, attached: { sheet: picked.sheet, anchor: picked.anchor } };
  const basePrompt = buildImagePrompt(promptBase);
  const [w, h] = ctx.cfg.providers.image.upscaleTo;
  const cacheKey = cacheKeyOf({
    provider: ctx.providers.image.id, model: ctx.providers.image.model, prompt: basePrompt,
    refsHash: hashBuffers(withSheet ? sheet.asset.id : "", picked.anchor ? anchor.asset.id : ""),
    params: { gen, w, h, ...(style.shared_lock ? { lock: CHARACTER_LOCK_VERSION, sceneStyle: SCENE_STYLE_VERSION } : {}) },
  });

  let asset = await ctx.assets.findByCacheKey(project.id, cacheKey);
  let cost = 0;
  if (!asset) {
    let finalBuf: Buffer | null = null;
    let textFound: string | null = null;
    // labels the picture should show: null = not checked, true/false = OCR found them / did not (after the retry)
    let labelsOk: boolean | null = null;
    let labelsMissing: string[] = [];
    const useOcr = ctx.cfg.env.OCR !== "off" && !ctx.cfg.mockProviders;
    for (let attempt = 0; attempt < 2 && !finalBuf; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : buildImagePrompt({ ...promptBase, strongNoText: true, strongSpelling: true });
      const res = await ctx.providers.image.generate({ prompt, refs, aspect: "16:9" });
      cost += res.costUsd;
      const fitted = await fitTo16x9(res.image, w, h);
      const quality = await checkImageQuality(fitted);
      if (!quality.ok) {
        if (attempt === 1) throw new ProviderError(`Image failed the quality check (${quality.reason}) twice`, undefined, false, "invalid");
        continue;
      }
      if (labels.length) {
        // this picture is meant to carry words: they must be spelled right (one retry), no "no text" check
        if (useOcr) {
          const read = await recognizeText(fitted, `${ctx.cfg.dataDir}/tessdata`).catch(() => null);
          if (read) {
            const m = labelsMatch(labels, read.text);
            labelsOk = m.ok;
            labelsMissing = m.missing;
            if (!m.ok && attempt === 0) continue;
          }
        }
      } else if (useOcr) {
        const ocr = await detectText(fitted, `${ctx.cfg.dataDir}/tessdata`).catch(() => ({ hasText: false, sample: "" }));
        if (ocr.hasText) {
          textFound = ocr.sample;
          if (attempt === 0) continue; // regenerate once with a stronger "no text" constraint
        } else textFound = null;
      }
      finalBuf = fitted;
    }
    if (!finalBuf) throw new ProviderError("Image generation produced no usable result", undefined, false, "invalid");

    const jpg = await sharp(finalBuf).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    const storageKey = projectKey(project.id, "images", `s${String(scene.idx + 1).padStart(4, "0")}-${cacheKey.slice(0, 8)}.jpg`);
    const bytes = await ctx.storage.put(storageKey, jpg);
    asset = await ctx.assets.create({
      projectId: project.id, sceneId: scene.id, type: "image", storageKey, mime: "image/jpeg",
      provider: ctx.providers.image.id, model: ctx.providers.image.model,
      params: {
        gen, width: w, height: h,
        ...(style.shared_lock ? { lockVersion: CHARACTER_LOCK_VERSION, sceneStyleVersion: SCENE_STYLE_VERSION, lighting: scene.lighting, ...(withSheet ? { heroSheet: wantsModern ? "modern" : "ancient" } : {}) } : {}),
        ...(textFound ? { textDetected: textFound } : {}),
        ...(labels.length ? { labels, labelsVerified: labelsOk, ...(labelsMissing.length ? { labelsMissing } : {}) } : {}),
      },
      cacheKey, costUsd: cost, bytes,
    });
  }

  scene.imageAssetId = asset.id;
  scene.errors = { ...scene.errors, image: undefined };
  await saveScene(ctx, scene);
  await markDownstreamStale(ctx, project, scene.id, "image");
  await ctx.events.publish(project.id, "asset", { kind: "image", sceneId: scene.id, assetId: asset.id });
  return { costUsd: cost };
};
