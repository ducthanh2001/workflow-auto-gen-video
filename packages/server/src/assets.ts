import { createHash } from "node:crypto";
import { In, type DataSource, type EntityManager } from "typeorm";
import type { AssetType } from "@vp/shared";
import { Asset } from "./entities";

/** sha256(provider + model + prompt + refsHash + params) -- spec 4 */
export function cacheKeyOf(parts: { provider: string; model: string; prompt: string; refsHash?: string; params?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.provider, parts.model, parts.prompt, parts.refsHash ?? "", parts.params ?? null]))
    .digest("hex");
}

export function hashBuffers(...bufs: Array<Buffer | string>): string {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest("hex");
}

export interface NewAsset {
  projectId: string;
  sceneId?: string | null;
  type: AssetType;
  storageKey: string;
  mime?: string | null;
  provider?: string | null;
  model?: string | null;
  params?: Record<string, unknown>;
  cacheKey?: string | null;
  costUsd?: number;
  durationSec?: number | null;
  bytes?: number;
}

export class AssetService {
  constructor(private readonly ds: DataSource) {}

  get(id: string, em?: EntityManager): Promise<Asset | null> {
    return (em ?? this.ds.manager).getRepository(Asset).findOneBy({ id });
  }

  findByCacheKey(projectId: string, cacheKey: string): Promise<Asset | null> {
    return this.ds.getRepository(Asset).findOneBy({ projectId, cacheKey });
  }

  async create(a: NewAsset): Promise<Asset> {
    const repo = this.ds.getRepository(Asset);
    return repo.save(
      repo.create({
        sceneId: null, mime: null, provider: null, model: null, params: {}, cacheKey: null, costUsd: 0, durationSec: null, bytes: 0, stale: false,
        ...a,
      }),
    );
  }

  list(projectId: string, type?: AssetType): Promise<Asset[]> {
    return this.ds.getRepository(Asset).find({ where: type ? { projectId, type } : { projectId }, order: { createdAt: "ASC" } });
  }

  /** Mark the render products that depend on a scene as stale (spec 5). */
  async markStaleForScene(projectId: string, sceneId: string, kinds: Array<"segment" | "chunk" | "video" | "music_mix">): Promise<void> {
    const repo = this.ds.getRepository(Asset);
    if (kinds.includes("segment")) await repo.update({ projectId, sceneId, type: "segment" }, { stale: true });
    const rest = kinds.filter((k) => k !== "segment");
    if (rest.length) await repo.update({ projectId, type: In(rest) }, { stale: true });
  }

  async remove(id: string): Promise<void> {
    await this.ds.getRepository(Asset).delete({ id });
  }
}
