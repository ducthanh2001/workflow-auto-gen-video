import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderError } from "@vp/core";
import type { Ctx } from "../context";
import { Asset, Project, Scene } from "../entities";
import type { StageJobData } from "../queues";

export interface StageResult {
  costUsd: number;
  note?: string;
}

export type StageFn = (ctx: Ctx, data: StageJobData) => Promise<StageResult>;

/** A failure that retrying cannot fix (bad config, blocked prompt, missing input). */
export function fatal(message: string): ProviderError {
  return new ProviderError(message, undefined, false, "invalid");
}

export async function loadProject(ctx: Ctx, id: string): Promise<Project> {
  const p = await ctx.ds.getRepository(Project).findOneBy({ id });
  if (!p) throw fatal(`project ${id} not found`);
  return p;
}

export async function loadScenes(ctx: Ctx, projectId: string): Promise<Scene[]> {
  return ctx.ds.getRepository(Scene).find({ where: { projectId }, order: { idx: "ASC" } });
}

export async function loadScene(ctx: Ctx, id: string): Promise<Scene> {
  const s = await ctx.ds.getRepository(Scene).findOneBy({ id });
  if (!s) throw fatal(`scene ${id} not found`);
  return s;
}

export async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** ready = audio and image present; failed = any stage error; otherwise pending. */
export function computeSceneStatus(s: Scene): Scene["status"] {
  if (Object.values(s.errors ?? {}).some(Boolean)) return "failed";
  return s.audioAssetId && s.imageAssetId ? "ready" : "pending";
}

export async function saveScene(ctx: Ctx, s: Scene): Promise<Scene> {
  s.status = computeSceneStatus(s);
  s.error = Object.values(s.errors ?? {}).filter(Boolean).join("; ") || null;
  return ctx.ds.getRepository(Scene).save(s);
}

export async function readAsset(ctx: Ctx, assetId: string | null | undefined): Promise<{ asset: Asset; data: Buffer } | null> {
  if (!assetId) return null;
  const asset = await ctx.assets.get(assetId);
  if (!asset) return null;
  return { asset, data: await ctx.storage.read(asset.storageKey) };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
