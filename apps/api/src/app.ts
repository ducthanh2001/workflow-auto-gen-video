import "reflect-metadata";
import { Controller, Get, Inject, Module, type INestApplication } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Pipeline, checkDeps, type Ctx } from "@vp/server";
import type IORedis from "ioredis";
import { AllExceptionsFilter, AuthGuard, CTX, PIPELINE } from "./common";
import { ProjectsController } from "./projects.controller";
import { ScenesController } from "./scenes.controller";
import { AssetsController } from "./assets.controller";
import { MusicController } from "./music.controller";
import { GlobalHeroController } from "./globalhero.controller";

type FullCtx = Ctx & { redis: IORedis };

@Controller("health")
class HealthController {
  constructor(@Inject(CTX) private readonly ctx: FullCtx) {}

  /** ffmpeg + filters, fonts, DB, Redis, which keys are configured (never their values). */
  @Get("deps")
  deps() {
    return checkDeps(this.ctx.cfg, this.ctx.ds, this.ctx.redis);
  }
}

export function buildAppModule(ctx: FullCtx) {
  @Module({
    controllers: [ProjectsController, ScenesController, AssetsController, MusicController, GlobalHeroController, HealthController],
    providers: [
      { provide: CTX, useValue: ctx },
      { provide: PIPELINE, useValue: new Pipeline(ctx) },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  })
  class AppModule {}
  return AppModule;
}

export async function createApp(ctx: FullCtx): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(buildAppModule(ctx), { logger: ["error", "warn"], bodyParser: true });
  app.disable("x-powered-by");
  // a 100+ scene plan pasted as JSON is larger than the 100 kb default
  app.useBodyParser("json", { limit: "3mb" });
  return app;
}
