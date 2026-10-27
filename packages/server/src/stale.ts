import { STALE_AFTER } from "@vp/core";
import type { Ctx } from "./context";
import { Project } from "./entities";

/**
 * A changed scene asset makes later products stale (spec 5): its segment, every
 * chunk and the rendered videos. The project row lists which outputs are out of date.
 */
export async function markDownstreamStale(
  ctx: Ctx,
  project: Project,
  sceneId: string,
  what: keyof typeof STALE_AFTER,
): Promise<void> {
  await ctx.assets.markStaleForScene(project.id, sceneId, STALE_AFTER[what]);
  const fresh = await ctx.ds.getRepository(Project).findOneBy({ id: project.id });
  if (!fresh) return;
  const hasVideo = await ctx.assets.list(project.id, "video");
  const stale = new Set(fresh.stale);
  for (const v of hasVideo) stale.add(String(v.params.mode ?? "final"));
  if (stale.size !== fresh.stale.length) {
    await ctx.ds.getRepository(Project).update(project.id, { stale: [...stale] });
  }
}
