import "reflect-metadata";
import { AssetService } from "./assets";
import { loadConfig, createProviders, type AppConfig } from "./config";
import type { Ctx } from "./context";
import { initDb } from "./db";
import { EventBus } from "./events";
import { createQueues, createRedis } from "./queues";
import { LocalDiskStorage } from "./storage";

export * from "./assets";
export * from "./config";
export * from "./context";
export * from "./db";
export * from "./entities";
export * from "./events";
export * from "./globalHero";
export * from "./health";
export * from "./pipeline";
export * from "./queues";
export * from "./stages";
export * from "./storage";

/** Build the shared context for the API or the worker. */
export async function createContext(opts: { cfg?: AppConfig; migrate?: boolean; log?: Ctx["log"] } = {}): Promise<Ctx & { redis: ReturnType<typeof createRedis> }> {
  const cfg = opts.cfg ?? loadConfig();
  const ds = await initDb(cfg.databaseUrl, { migrate: opts.migrate });
  const redis = createRedis(cfg.redisUrl);
  return {
    cfg,
    ds,
    redis,
    storage: new LocalDiskStorage(cfg.dataDir),
    assets: new AssetService(ds),
    providers: createProviders(cfg),
    events: new EventBus(cfg.redisUrl),
    queues: createQueues(redis),
    log: opts.log ?? ((m, e) => console.log(m, e ? JSON.stringify(e) : "")),
  };
}
export * from "./workers";
