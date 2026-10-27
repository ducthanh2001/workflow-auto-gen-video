import { parseScript, planScenes } from "@vp/core";
import type { SceneDraft } from "@vp/shared";
import type { Ctx } from "../context";
import { Asset, Project, Scene } from "../entities";
import { projectKey } from "../storage";
import { fatal, loadProject, type StageFn } from "./common";

/**
 * Replace every scene of a project with `scenes` (used by the LLM planner and by "Import plan").
 * Re-planning also drops what was generated for the old scenes.
 */
export async function savePlan(ctx: Ctx, project: Project, scenes: SceneDraft[], warnings: string[]): Promise<void> {
  await ctx.ds.transaction(async (em) => {
    await em.getRepository(Asset).createQueryBuilder().delete().where('"projectId" = :id AND "sceneId" IS NOT NULL', { id: project.id }).execute();
    await em.getRepository(Scene).delete({ projectId: project.id });
    await em.getRepository(Scene).insert(
      scenes.map((s, idx) => ({
        projectId: project.id,
        idx,
        beat: s.beat,
        narration: s.narration,
        visual: s.visual,
        characters: s.characters ?? [],
        imageText: s.imageText ?? [],
        lighting: s.lighting,
        shot: s.shot,
        camera: s.camera,
        motion: s.motion,
        transitionOut: s.transitionOut,
        onScreenText: s.onScreenText,
        approved: false,
        status: "pending" as const,
        error: null,
        gen: {},
        errors: {},
      })),
    );
    await em.getRepository(Project).update(project.id, {
      meta: { ...project.meta, planWarnings: warnings },
      stale: [],
    });
  });
  await ctx.storage.removeDir(projectKey(project.id, "scenes")).catch(() => undefined);
  await ctx.events.publish(project.id, "asset", { kind: "plan", scenes: scenes.length });
}

/** Scene planning (spec 6.2). Narration is verbatim-checked and immutable afterwards. */
export const planStage: StageFn = async (ctx, data) => {
  const project = await loadProject(ctx, data.projectId);
  const parsed = parseScript(project.scriptRaw);
  const clipsAllowed = ctx.providers.video ? project.settings.maxAiClipShare : 0;

  let result;
  try {
    result = await planScenes(parsed, ctx.providers.llm, {
      maxAiClipShare: clipsAllowed,
      maxVerbatimRetries: ctx.cfg.providers.planner.maxVerbatimRetries,
      defaultCamera: ctx.cfg.providers.planner.defaultCamera,
      defaultTransition: ctx.cfg.providers.planner.defaultTransition,
    });
  } catch (e) {
    if ((e as Error).name === "PlanError") throw fatal((e as Error).message);
    throw e;
  }

  await savePlan(ctx, project, result.scenes, result.warnings);
  return { costUsd: result.costUsd, note: `${result.scenes.length} scenes in ${result.attempts} attempt(s)` };
};
