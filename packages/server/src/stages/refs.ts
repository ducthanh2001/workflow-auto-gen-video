import sharp from "sharp";
import { CHARACTER_LOCK_VERSION, heroSheetPrompt } from "@vp/shared";
import { buildImagePrompt, mapLimit, pickRefs, type ImageRef } from "@vp/core";
import { Asset, Project } from "../entities";
import type { Ctx } from "../context";
import { cacheKeyOf } from "../assets";
import { projectKey } from "../storage";
import { readGlobal } from "../globalHero";
import { fatal, loadProject, type StageFn } from "./common";

const HERO = [{ role: "hero" }];
const ANCHOR_SCENES: Array<{ visual: string; characters: Array<{ role: string }> }> = [
  { visual: "A calm establishing scene: a small round-headed figure on a lantern-lit path at dusk, deep blue sky, warm orange light", characters: HERO },
  { visual: "An interior at night: a candle on a wooden table beside a window, a figure sitting quietly, cool blue shadows", characters: HERO },
  { visual: "A wide landscape at dawn: a river, distant hills and a tiny figure on a bridge, soft orange against blue", characters: HERO },
  { visual: "A close study of a table: an old clock and a lamp, painterly texture, strong warm and cool contrast", characters: [] },
];

/**
 * Put a global hero sheet (or the global style sample) into a project as an uploaded asset. Re-uses the project's copy when it was made
 * from the same file (same hash), so running the references step again does not pile up duplicates.
 */
async function adoptGlobalSheet(ctx: Ctx, project: Project, existing: Asset[], kind: "sheet" | "modern" | "anchor"): Promise<Asset | null> {
  const g = await readGlobal(ctx.cfg, kind);
  if (!g) return null;
  const role = kind === "modern" ? "character_sheet_modern" : kind === "anchor" ? "anchor" : "character_sheet";
  const have = existing.find((a) => a.params.role === role && a.params.global === true && a.params.globalHash === g.hash);
  if (have) return have;
  const jpg = await sharp(g.data).resize(1920, 1080, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 95 }).toBuffer();
  const key = projectKey(project.id, "refs", `${role}-global-${g.hash}.jpg`);
  const bytes = await ctx.storage.put(key, jpg);
  return ctx.assets.create({
    projectId: project.id, type: "ref", storageKey: key, mime: "image/jpeg",
    params: { role, uploaded: true, global: true, globalHash: g.hash, lockVersion: CHARACTER_LOCK_VERSION }, bytes,
  });
}

/** Reference bootstrapping (spec 6.3): the character sheet and 4 candidate style anchors. */
export const refsStage: StageFn = async (ctx, data) => {
  const project = await loadProject(ctx, data.projectId);
  const style = ctx.cfg.styles[project.settings.style];
  if (!style) throw fatal(`unknown style "${project.settings.style}"`);
  const repo = ctx.ds.getRepository(Asset);
  const existing = await repo.find({ where: { projectId: project.id, type: "ref" } });
  // Each manual run bumps the nonce so "regenerate" really calls the provider again.
  const nonce = (project.meta as { refsGen?: number }).refsGen ?? 0;
  let cost = 0;

  const store = async (role: string, index: number, prompt: string, refs: ImageRef[]) => {
    const key = cacheKeyOf({ provider: ctx.providers.image.id, model: ctx.providers.image.model, prompt, refsHash: refs.map((r) => r.data.length).join(","), params: { role, index, nonce } });
    const hit = await ctx.assets.findByCacheKey(project.id, key);
    if (hit) return hit;
    const res = await ctx.providers.image.generate({ prompt, refs, aspect: "16:9" });
    cost += res.costUsd;
    const jpg = await sharp(res.image).resize(1920, 1080, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
    const storageKey = projectKey(project.id, "refs", `${role}-${index}-${key.slice(0, 8)}.jpg`);
    const bytes = await ctx.storage.put(storageKey, jpg);
    return ctx.assets.create({
      projectId: project.id, type: "ref", storageKey, mime: "image/jpeg", provider: ctx.providers.image.id, model: ctx.providers.image.model,
      params: { role, index, nonce }, cacheKey: key, costUsd: res.costUsd, bytes,
    });
  };

  // 1. The hero. Priority: the user's own upload for this project, then the global hero sheet, then a new drawing.
  let sheet = existing.find((a) => a.params.role === "character_sheet" && a.params.uploaded === true && a.params.global !== true) ?? null;
  let usedGlobal = false;
  if (!sheet && style.shared_lock) {
    sheet = await adoptGlobalSheet(ctx, project, existing, "sheet");
    usedGlobal = !!sheet;
  }
  if (!sheet) {
    const prompt = style.character_sheet_prompt
      ? [style.character_sheet_prompt.replace(/\s+/g, " ").trim(), "No real people."].join("\n")
      : [
          style.prefix.replace(/\s+/g, " ").trim(),
          "Character sheet: one simple original character shown in three poses (front view, side view, three-quarter view), side by side on a plain light background, full body, identical proportions and line weight in every pose.",
          "No text, no labels, no watermark, no real people.",
        ].join("\n");
    // a clean frame of the hero from a published video, when the owner has stored one, is the exact look reference
    const reference = style.shared_lock && ctx.providers.image.acceptsRefs !== false ? await readGlobal(ctx.cfg, "reference") : null;
    const refs: ImageRef[] = reference ? [{ mime: "image/png", data: reference.data }] : [];
    // without a picture to copy, "use the attached image" would only confuse the model
    const text = refs.length ? prompt : prompt.replace(/Use the attached image as the exact reference for the character:/, "The character:");
    sheet = await store("character_sheet", 0, text, refs);
  }
  const sheetData = await ctx.storage.read(sheet.storageKey);

  // 2. The modern-outfit sheet only exists as a global file (made once with "Generate modern sheet").
  const modern = style.shared_lock ? await adoptGlobalSheet(ctx, project, existing, "modern") : null;

  // 3. Style sample: the owner's saved global one (nothing is drawn), otherwise 4 candidates to pick from.
  //    The style may bring its own candidate scenes (a bright daytime look); otherwise the built-in night scenes.
  const globalAnchor = style.shared_lock ? await adoptGlobalSheet(ctx, project, existing, "anchor") : null;
  if (!globalAnchor) {
    const anchors = style.anchor_scenes?.map((a) => ({ visual: a.visual, characters: a.characters ? HERO : [] })) ?? ANCHOR_SCENES;
    await mapLimit(anchors, 2, (scene, i) =>
      store(
        "anchor", i,
        buildImagePrompt({ style, visual: scene.visual, shot: "wide", characters: scene.characters }),
        pickRefs(scene.characters, { sheet: { mime: "image/jpeg", data: sheetData } }),
      ),
    );
  }

  await ctx.ds.getRepository(Project).update(project.id, {
    characterSheetAssetId: sheet.id,
    styleAnchorAssetId: globalAnchor?.id ?? null,
    meta: {
      ...project.meta,
      characterSheetModernAssetId: modern?.id ?? null,
      ...(style.shared_lock ? { characterLockVersion: CHARACTER_LOCK_VERSION } : {}),
    },
  });
  await ctx.events.publish(project.id, "asset", { kind: "refs", usedGlobalHero: usedGlobal });
  return { costUsd: cost, note: usedGlobal || globalAnchor ? `used the global ${[usedGlobal && "hero sheet", globalAnchor && "style sample"].filter(Boolean).join(" and ")}` : undefined };
};

/**
 * Put the saved global hero sheet(s) into a project right now, without drawing anything (free and instant).
 * Only while the references are not approved yet. The style anchors already drawn are kept.
 */
export async function applyGlobalHero(ctx: Ctx, projectId: string): Promise<{ sheet: boolean; modern: boolean; anchor: boolean }> {
  const project = await loadProject(ctx, projectId);
  const style = ctx.cfg.styles[project.settings.style];
  if (!style?.shared_lock) throw fatal("the global hero belongs to the shared hero style (stickman-hero)");
  if (project.status !== "refs_ready") throw fatal("the hero can only be swapped while the references wait for your approval");
  const existing = await ctx.ds.getRepository(Asset).find({ where: { projectId, type: "ref" } });
  const sheet = await adoptGlobalSheet(ctx, project, existing, "sheet");
  const modern = await adoptGlobalSheet(ctx, project, existing, "modern");
  const anchor = await adoptGlobalSheet(ctx, project, existing, "anchor");
  if (!sheet && !modern && !anchor) throw fatal("no global hero sheet or style sample saved yet: upload one first");
  await ctx.ds.getRepository(Project).update(projectId, {
    ...(sheet ? { characterSheetAssetId: sheet.id } : {}),
    ...(anchor ? { styleAnchorAssetId: anchor.id } : {}),
    meta: { ...project.meta, ...(modern ? { characterSheetModernAssetId: modern.id } : {}), characterLockVersion: CHARACTER_LOCK_VERSION },
  });
  await ctx.events.publish(projectId, "asset", { kind: "refs_selected" });
  return { sheet: !!sheet, modern: !!modern, anchor: !!anchor };
}

/**
 * Draw the modern-outfit hero sheet from the project's ancient sheet (one image). The owner then saves it as
 * the global modern sheet. Runs in the API process because it is a single call.
 */
export async function generateModernSheet(ctx: Ctx, projectId: string): Promise<Asset> {
  const project = await loadProject(ctx, projectId);
  const style = ctx.cfg.styles[project.settings.style];
  if (!style?.shared_lock) throw fatal("the modern sheet belongs to the shared hero style (stickman-hero)");
  if (!project.characterSheetAssetId) throw fatal("create or choose the hero sheet first");
  const base = await ctx.assets.get(project.characterSheetAssetId);
  if (!base) throw fatal("hero sheet not found");
  const withRef = ctx.providers.image.acceptsRefs !== false;
  const refs: ImageRef[] = withRef ? [{ mime: base.mime ?? "image/jpeg", data: await ctx.storage.read(base.storageKey) }] : [];
  const prompt = withRef ? heroSheetPrompt("modern") : heroSheetPrompt("modern").replace(/Use the attached image as the exact reference for the character:/, "The character:");
  const res = await ctx.providers.image.generate({ prompt, refs, aspect: "16:9" });
  const jpg = await sharp(res.image).resize(1920, 1080, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
  const key = projectKey(project.id, "refs", `character_sheet_modern-draft-${Date.now()}.jpg`);
  const bytes = await ctx.storage.put(key, jpg);
  const asset = await ctx.assets.create({
    projectId: project.id, type: "ref", storageKey: key, mime: "image/jpeg", provider: ctx.providers.image.id, model: ctx.providers.image.model,
    params: { role: "character_sheet_modern_draft", lockVersion: CHARACTER_LOCK_VERSION }, costUsd: res.costUsd, bytes,
  });
  await ctx.events.publish(project.id, "asset", { kind: "refs" });
  return asset;
}
