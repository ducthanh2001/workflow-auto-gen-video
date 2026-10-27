import { existsSync } from "node:fs";
import path from "node:path";
import type IORedis from "ioredis";
import type { DataSource } from "typeorm";
import { ffmpegCapabilities } from "@vp/core";
import { imageProviderChoice, keyStatus, type AppConfig } from "./config";

export interface DepsReport {
  ok: boolean;
  ffmpeg: { ok: boolean; version?: string; major?: number; missing: string[]; amixNormalize?: boolean; error?: string };
  fonts: { ok: boolean; missing: string[] };
  db: { ok: boolean; error?: string };
  redis: { ok: boolean; error?: string };
  keys: Record<string, "configured" | "missing">;
  mockProviders: boolean;
  warnings: string[];
}

const REQUIRED_FILTERS = ["xfade", "zoompan", "loudnorm", "sidechaincompress", "acrossfade", "amix", "ass", "concat", "apad", "adelay"];

/** Used by GET /health/deps and the vp-doctor script. Never prints key values. */
export async function checkDeps(cfg: AppConfig, ds: DataSource | null, redis: IORedis | null): Promise<DepsReport> {
  const warnings: string[] = [];
  const ffmpeg: DepsReport["ffmpeg"] = { ok: false, missing: [] };
  try {
    const caps = await ffmpegCapabilities();
    ffmpeg.version = caps.version;
    ffmpeg.major = Number(/^[a-z]*-?(\d+)/i.exec(caps.version)?.[1] ?? NaN);
    ffmpeg.amixNormalize = caps.amixNormalize;
    ffmpeg.missing = [
      ...REQUIRED_FILTERS.filter((f) => !caps.filters[f]).map((f) => `filter:${f}`),
      ...(caps.encoders.libx264 ? [] : ["encoder:libx264"]),
      ...(caps.encoders.aac ? [] : ["encoder:aac"]),
    ];
    ffmpeg.ok = ffmpeg.missing.length === 0 && caps.amixNormalize;
    if (!caps.amixNormalize) warnings.push("amix has no `normalize` option (needs ffmpeg 7.x); ducking mix would be louder than expected");
    if (ffmpeg.major !== undefined && ffmpeg.major < 7) warnings.push(`ffmpeg ${caps.version} is older than 7.x; the Docker image ships 7.x`);
  } catch (e) {
    ffmpeg.error = (e as Error).message.slice(0, 200);
  }

  const wanted = ["Inter.ttf", "Anton-Regular.ttf"];
  const fontsMissing = wanted.filter((f) => !existsSync(path.join(cfg.fontsDir, f)));

  const db: DepsReport["db"] = { ok: false };
  try {
    if (ds) {
      await ds.query("SELECT 1");
      db.ok = true;
    } else db.error = "no connection";
  } catch (e) {
    db.error = (e as Error).message.slice(0, 160);
  }
  const rd: DepsReport["redis"] = { ok: false };
  try {
    if (redis) {
      rd.ok = (await redis.ping()) === "PONG";
    } else rd.error = "no connection";
  } catch (e) {
    rd.error = (e as Error).message.slice(0, 160);
  }

  const keys = keyStatus(cfg.env);
  if (!cfg.mockProviders) {
    // only the keys of the image service in use matter: Gemini or APIZ
    const unusedImageKeys = imageProviderChoice(cfg.env) === "apiz" ? /^GEMINI_/ : /^APIZ_/;
    for (const [k, v] of Object.entries(keys)) {
      if (v === "missing" && k !== "FAL_API_KEY" && !unusedImageKeys.test(k)) warnings.push(`${k} is not configured`);
    }
    if (keys.FAL_API_KEY === "missing") warnings.push("FAL_API_KEY is not configured: AI clips are off, Ken Burns only");
    for (const [name, v] of Object.entries(cfg.voices)) {
      if (v.voiceId.startsWith("REPLACE_")) warnings.push(`voice "${name}" still has the placeholder voiceId in config/voices.json`);
      else if (!v.commercialUseConfirmed) warnings.push(`voice "${name}" is not marked commercialUseConfirmed`);
    }
  } else warnings.push("PROVIDERS=mock: no real provider is called");

  return {
    ok: ffmpeg.ok && fontsMissing.length === 0 && db.ok && rd.ok,
    ffmpeg, fonts: { ok: fontsMissing.length === 0, missing: fontsMissing }, db, redis: rd, keys, mockProviders: cfg.mockProviders, warnings,
  };
}
