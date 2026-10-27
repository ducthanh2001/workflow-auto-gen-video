import type { MigrationInterface, QueryRunner } from "typeorm";

export class Init1700000000000 implements MigrationInterface {
  name = "Init1700000000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await q.query(`
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" varchar(200) NOT NULL,
  "title" varchar(300) NOT NULL,
  "status" varchar(40) NOT NULL DEFAULT 'created',
  "settings" jsonb NOT NULL,
  "scriptRaw" text NOT NULL,
  "meta" jsonb NOT NULL DEFAULT '{}',
  "runTo" varchar(40),
  "characterSheetAssetId" uuid,
  "styleAnchorAssetId" uuid,
  "stale" jsonb NOT NULL DEFAULT '[]',
  "createdAt" timestamptz NOT NULL DEFAULT now()
)`);
    await q.query(`CREATE UNIQUE INDEX "IDX_projects_slug" ON "projects" ("slug")`);

    await q.query(`
CREATE TABLE "scenes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "idx" int NOT NULL,
  "beat" varchar(300) NOT NULL,
  "narration" text NOT NULL,
  "visual" text NOT NULL,
  "shot" varchar(20) NOT NULL,
  "camera" varchar(20) NOT NULL,
  "motion" varchar(20) NOT NULL,
  "transitionOut" varchar(20) NOT NULL,
  "onScreenText" varchar(40),
  "approved" boolean NOT NULL DEFAULT false,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "error" text,
  "audioAssetId" uuid,
  "imageAssetId" uuid,
  "clipAssetId" uuid,
  "audioDurationSec" double precision,
  "slotSec" double precision,
  "gen" jsonb NOT NULL DEFAULT '{}',
  "errors" jsonb NOT NULL DEFAULT '{}'
)`);
    await q.query(`CREATE INDEX "IDX_scenes_project" ON "scenes" ("projectId")`);
    await q.query(`CREATE UNIQUE INDEX "IDX_scenes_project_idx" ON "scenes" ("projectId","idx")`);

    await q.query(`
CREATE TABLE "assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "sceneId" uuid,
  "type" varchar(20) NOT NULL,
  "storageKey" varchar(500) NOT NULL,
  "mime" varchar(80),
  "provider" varchar(60),
  "model" varchar(120),
  "params" jsonb NOT NULL DEFAULT '{}',
  "cacheKey" varchar(64),
  "costUsd" numeric(12,4) NOT NULL DEFAULT 0,
  "durationSec" double precision,
  "bytes" bigint NOT NULL DEFAULT 0,
  "stale" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now()
)`);
    await q.query(`CREATE INDEX "IDX_assets_project" ON "assets" ("projectId")`);
    await q.query(`CREATE UNIQUE INDEX "IDX_assets_project_cache" ON "assets" ("projectId","cacheKey") WHERE "cacheKey" IS NOT NULL`);

    await q.query(`
CREATE TABLE "jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "sceneId" uuid,
  "stage" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'queued',
  "attempts" int NOT NULL DEFAULT 0,
  "error" text,
  "costUsd" numeric(12,4) NOT NULL DEFAULT 0,
  "startedAt" timestamptz,
  "finishedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
)`);
    await q.query(`CREATE INDEX "IDX_jobs_project" ON "jobs" ("projectId")`);

    await q.query(`
CREATE TABLE "music_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(200) NOT NULL,
  "storageKey" varchar(500) NOT NULL,
  "durationSec" double precision NOT NULL,
  "licenseNote" text NOT NULL CHECK (length(trim("licenseNote")) > 0),
  "createdAt" timestamptz NOT NULL DEFAULT now()
)`);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of ["music_tracks", "jobs", "assets", "scenes", "projects"]) await q.query(`DROP TABLE IF EXISTS "${t}"`);
  }
}
