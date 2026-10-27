import { Worker } from "bullmq";
import type { Ctx } from "./context";
import { Pipeline } from "./pipeline";
import { QUEUE_CONCURRENCY, QUEUE_NAMES, createRedis, type StageJobData } from "./queues";

/** One BullMQ worker per stage queue, with the concurrency from spec 13. */
export function startWorkers(ctx: Ctx): { close: () => Promise<void>; pipeline: Pipeline } {
  const pipeline = new Pipeline(ctx);
  const workers = QUEUE_NAMES.map((name) => {
    const w = new Worker<StageJobData>(`vp-${name}`, (job) => pipeline.runJob(job), {
      connection: createRedis(ctx.cfg.redisUrl),
      concurrency: QUEUE_CONCURRENCY[name],
    });
    w.on("error", (e) => ctx.log(`worker ${name} error`, { message: e.message }));
    return w;
  });
  return {
    pipeline,
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
