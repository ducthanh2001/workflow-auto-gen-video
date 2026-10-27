import type { DataSource } from "typeorm";
import type { Providers } from "@vp/core";
import type { AppConfig } from "./config";
import type { StorageService } from "./storage";
import type { AssetService } from "./assets";
import type { EventBus } from "./events";
import type { Queues } from "./queues";

/** Everything a stage or the orchestrator needs. The API and the worker build one each. */
export interface Ctx {
  cfg: AppConfig;
  ds: DataSource;
  storage: StorageService;
  assets: AssetService;
  providers: Providers;
  events: EventBus;
  /** null in unit tests that never enqueue */
  queues: Queues | null;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}
