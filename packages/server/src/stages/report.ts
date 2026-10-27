import type { Ctx } from "../context";
import { Asset, Job, Project } from "../entities";
import { projectKey } from "../storage";

/** report.json (spec 2.2): per-stage cost, durations, retries, measured A/V drift. */
export async function writeReport(ctx: Ctx, projectId: string): Promise<void> {
  const project = await ctx.ds.getRepository(Project).findOneByOrFail({ id: projectId });
  const jobs = await ctx.ds.getRepository(Job).find({ where: { projectId } });
  const stages: Record<string, { jobs: number; succeeded: number; failed: number; retries: number; costUsd: number; seconds: number }> = {};
  for (const j of jobs) {
    const s = (stages[j.stage] ??= { jobs: 0, succeeded: 0, failed: 0, retries: 0, costUsd: 0, seconds: 0 });
    s.jobs++;
    if (j.status === "succeeded") s.succeeded++;
    if (j.status === "failed") s.failed++;
    s.retries += Math.max(0, j.attempts - 1);
    s.costUsd += j.costUsd;
    if (j.startedAt && j.finishedAt) s.seconds += (j.finishedAt.getTime() - j.startedAt.getTime()) / 1000;
  }
  for (const s of Object.values(stages)) {
    s.costUsd = Math.round(s.costUsd * 10000) / 10000;
    s.seconds = Math.round(s.seconds * 10) / 10;
  }
  const videos = await ctx.ds.getRepository(Asset).find({ where: { projectId, type: "video" } });
  const final = videos.find((v) => v.params.mode === "final");
  const total = Object.values(stages).reduce((a, s) => a + s.costUsd, 0);

  const report = {
    project: { id: project.id, title: project.title, status: project.status },
    generatedAt: new Date().toISOString(),
    totals: { costUsd: Math.round(total * 10000) / 10000, capUsd: project.settings.maxUsdPerRun },
    stages,
    final: final
      ? {
          videoSec: final.params.videoSec, audioSec: final.params.audioSec, driftMs: final.params.driftMs,
          loudnessBefore: final.params.loudnessBefore, scenes: final.params.scenes,
        }
      : null,
    clipFallbacks: project.meta.clipFallbacks ?? [],
    planWarnings: project.meta.planWarnings ?? [],
  };
  const key = projectKey(projectId, "out", "report.json");
  const old = await ctx.ds.getRepository(Asset).find({ where: { projectId, type: "doc" } });
  for (const a of old) if (a.params.kind === "report") await ctx.ds.getRepository(Asset).delete({ id: a.id });
  const bytes = await ctx.storage.put(key, Buffer.from(JSON.stringify(report, null, 2), "utf8"));
  await ctx.assets.create({ projectId, type: "doc", storageKey: key, mime: "application/json", params: { kind: "report" }, bytes });
}
