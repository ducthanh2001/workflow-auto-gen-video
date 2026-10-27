import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import type { Stage } from "@vp/shared";

export const QUEUE_NAMES = ["plan", "voice", "image", "clip", "render", "thumb"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const STAGE_QUEUE: Record<Stage, QueueName> = {
  plan: "plan",
  refs: "image",
  voice: "voice",
  image: "image",
  clip: "clip",
  render_draft: "render",
  render_final: "render",
  thumb: "thumb",
  metadata: "plan",
};

/** concurrency per queue (spec 13) */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  plan: 1, voice: 3, image: 4, clip: 2, render: 1, thumb: 1,
};

export interface StageJobData {
  /** Job row id */
  jobId: string;
  projectId: string;
  stage: Stage;
  sceneId?: string;
}

export const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { count: 2000 },
  removeOnFail: { count: 5000 },
};

export function createRedis(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export type Queues = Record<QueueName, Queue<StageJobData>>;

export function createQueues(connection: IORedis): Queues {
  return Object.fromEntries(
    QUEUE_NAMES.map((n) => [n, new Queue<StageJobData>(`vp-${n}`, { connection })]),
  ) as Queues;
}
