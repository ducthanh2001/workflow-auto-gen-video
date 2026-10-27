/**
 * Pipeline e2e with mocked providers (spec 17): real Postgres, Redis (BullMQ) and ffmpeg.
 * Needs: DATABASE_URL, REDIS_URL, FFMPEG_PATH/FFPROBE_PATH (see packages/server/README or the root README).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BudgetExceededError, MockTts, bins, probe, type TtsProvider } from "@vp/core";
import type { ProjectState } from "@vp/shared";
import {
  Asset, Pipeline, Project, Scene, Job, createContext, loadConfig, startWorkers,
  type Ctx,
} from "../src";

const DB = process.env.TEST_DATABASE_URL ?? "postgres://vp:vp@127.0.0.1:54329/vp";
const REDIS = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:63799";

function available(): boolean {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SENTENCES = [
  "At three twelve on a quiet afternoon, a heart stops beating in a small hospital room.",
  "For the person lying there, the world does not go dark all at once, it fades in stages.",
  "Doctors use two standards to say that a person has died, and they are not the same thing.",
  "The first is the end of breathing and circulation, which can be seen at the bedside.",
  "The second is the end of all brain function, which needs careful tests before anyone declares it.",
  "Within seconds of the heart stopping, oxygen runs out in the brain and consciousness slips away.",
  "Yet the cells of the body do not die together, and some keep working for hours afterward.",
  "Skin and bone can survive for a day, while neurons begin to fail within minutes.",
  "Researchers have studied these stages for decades, using careful observation and patient records.",
  "What they found surprised many, because death turns out to be a process rather than a moment.",
];
const SCRIPT = [
  "---", "title: What Happens in the First 24 Hours After You Die?", "language: en", "voice: narrator_calm", "style: warm-ink-cartoon",
  "sources:", "  - https://example.org/paper-1", "---", "",
  "## Hook", SENTENCES.slice(0, 4).join(" "), "",
  '## What "dead" means', SENTENCES.slice(4, 7).join(" "), "",
  "## The slow shutdown", SENTENCES.slice(7, 10).join(" "), "",
].join("\n");

async function waitFor<T>(what: string, fn: () => Promise<T | false | null | undefined>, timeoutMs = 240_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe.skipIf(!available())("pipeline e2e (mock providers)", () => {
  let ctx: Awaited<ReturnType<typeof createContext>>;
  let pipeline: Pipeline;
  let stop: () => Promise<void>;
  let dataDir: string;

  const status = async (id: string) => (await ctx.ds.getRepository(Project).findOneByOrFail({ id })).status;
  const waitStatus = (id: string, s: ProjectState) => waitFor(`status ${s}`, async () => ((await status(id)) === s ? true : false));

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-e2e-"));
    const cfg = loadConfig({
      ...process.env, DATABASE_URL: DB, REDIS_URL: REDIS, DATA_DIR: dataDir, PROVIDERS: "mock", OCR: "off",
      JOB_BACKOFF_MS: "30", RENDER_FAST: "1",
    });
    // start from a clean database and queue
    const { createDataSource } = await import("../src/db");
    const tmp = createDataSource(DB);
    await tmp.initialize();
    await tmp.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await tmp.destroy();
    ctx = await createContext({ cfg, log: () => undefined });
    await ctx.redis.flushdb();
    const w = startWorkers(ctx);
    pipeline = w.pipeline;
    stop = async () => {
      await w.close();
    };
  });

  afterAll(async () => {
    await stop?.();
    await ctx?.ds.destroy();
    await ctx?.redis.quit();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("runs from script to done, stopping at every gate", async () => {
    const { project } = await pipeline.createProject(SCRIPT);
    const id = project.id;
    expect(project.status).toBe("parsed");

    await pipeline.run(id, "done");
    // plan -> gate
    await waitStatus(id, "planned");
    const scenes = await ctx.ds.getRepository(Scene).find({ where: { projectId: id }, order: { idx: "ASC" } });
    expect(scenes.length).toBeGreaterThan(5);
    // narration is verbatim and immutable through the DTO
    expect(scenes.map((s) => s.narration).join(" ").replace(/\s+/g, " ")).toBe(SENTENCES.join(" "));
    await expect(pipeline.approve(id, "refs_approved")).rejects.toThrow(/cannot approve/);

    await pipeline.approve(id, "plan_approved");
    await waitStatus(id, "refs_ready");
    // refs gate needs a selected anchor
    await expect(pipeline.approve(id, "refs_approved")).rejects.toThrow(/style anchor/);
    const anchors = (await ctx.assets.list(id, "ref")).filter((a) => a.params.role === "anchor");
    expect(anchors).toHaveLength(4);
    await pipeline.selectRefs(id, { anchorAssetId: anchors[1].id });
    await pipeline.approve(id, "refs_approved");

    await waitStatus(id, "imaged"); // voice + image run automatically
    const afterImages = await ctx.ds.getRepository(Scene).find({ where: { projectId: id } });
    expect(afterImages.every((s) => s.audioAssetId && s.imageAssetId && s.audioDurationSec && s.audioDurationSec > 0.5)).toBe(true);
    await pipeline.approve(id, "images_approved");

    await waitStatus(id, "draft_rendered"); // clips (mock) then the draft render
    const draft = (await ctx.assets.list(id, "video")).find((a) => a.params.mode === "draft")!;
    expect(draft).toBeTruthy();
    const dinfo = await probe(ctx.storage.resolve(draft.storageKey));
    expect(dinfo.video).toMatchObject({ width: 960, height: 540 });
    await pipeline.approve(id, "draft_approved");

    await waitStatus(id, "done");
    const videos = await ctx.assets.list(id, "video");
    const final = videos.find((a) => a.params.mode === "final")!;
    const finfo = await probe(ctx.storage.resolve(final.storageKey));
    expect(finfo.video).toMatchObject({ width: 1920, height: 1080, codec: "h264", pixFmt: "yuv420p" });
    expect(finfo.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
    expect(Math.abs(finfo.video!.durationSec - finfo.audio!.durationSec)).toBeLessThan(0.05);

    expect((await ctx.assets.list(id, "srt"))).toHaveLength(1);
    expect((await ctx.assets.list(id, "ass"))).toHaveLength(1);
    const thumbs = await ctx.assets.list(id, "thumbnail");
    expect(thumbs.map((t) => t.params.variant).sort()).toEqual(["A", "B", "C"]);
    const docs = await ctx.assets.list(id, "doc");
    expect(docs.map((d) => d.params.kind).sort()).toEqual(["metadata", "report"]);
    const md = await ctx.storage.read(docs.find((d) => d.params.kind === "metadata")!.storageKey);
    expect(md.toString()).toMatch(/0:00 Hook/);
    const report = JSON.parse((await ctx.storage.read(docs.find((d) => d.params.kind === "report")!.storageKey)).toString());
    expect(report.stages.voice.succeeded).toBe(scenes.length);
    expect(report.final.driftMs).toBeLessThan(50);

    // every paid job recorded a cost row; spend is within the cap
    const spent = await pipeline.getSpent(id);
    expect(spent).toBeLessThanOrEqual(project.settings.maxUsdPerRun);
    expect((await ctx.ds.getRepository(Job).count({ where: { projectId: id, status: "failed" } }))).toBe(0);

    // --- regenerate one scene: downstream products become stale -----------------------
    const target = afterImages[2];
    const beforeImage = target.imageAssetId;
    await pipeline.regenerateScene(target.id, "image");
    await waitFor("new image", async () => {
      const s = await ctx.ds.getRepository(Scene).findOneByOrFail({ id: target.id });
      return s.imageAssetId && s.imageAssetId !== beforeImage;
    });
    await waitFor("stale flags", async () => {
      const assets = await ctx.ds.getRepository(Asset).find({ where: { projectId: id } });
      const seg = assets.find((a) => a.type === "segment" && a.sceneId === target.id);
      const otherSeg = assets.find((a) => a.type === "segment" && a.sceneId !== target.id);
      return !!seg?.stale && !otherSeg?.stale && assets.filter((a) => a.type === "chunk").every((a) => a.stale) &&
        assets.filter((a) => a.type === "video").every((a) => a.stale);
    });
    const p2 = await ctx.ds.getRepository(Project).findOneByOrFail({ id });
    expect(p2.stale.sort()).toEqual(["draft", "final"]);
    expect(p2.status).toBe("done"); // the project does not move backwards

    // re-render clears the stale flag
    await pipeline.enqueueStage(id, "render_final");
    await waitFor("final re-render", async () => !(await ctx.ds.getRepository(Project).findOneByOrFail({ id })).stale.includes("final"));
  });

  it("refuses to enqueue paid work over the budget cap, with the numbers", async () => {
    const { project } = await pipeline.createProject(SCRIPT);
    await ctx.ds.getRepository(Project).update(project.id, { settings: { ...project.settings, maxUsdPerRun: 0.01 } });
    await expect(pipeline.enqueueStage(project.id, "refs")).rejects.toThrow(BudgetExceededError);
    await expect(pipeline.enqueueStage(project.id, "refs")).rejects.toThrow(/cap \$0\.01/);
  });

  it("one failing scene does not fail the project; Retry resumes", async () => {
    const { project } = await pipeline.createProject(SCRIPT);
    const id = project.id;
    await pipeline.run(id, "refs_approved");
    await waitStatus(id, "planned");
    await pipeline.approve(id, "plan_approved");
    await waitStatus(id, "refs_ready");
    const anchors = (await ctx.assets.list(id, "ref")).filter((a) => a.params.role === "anchor");
    await pipeline.selectRefs(id, { anchorAssetId: anchors[0].id });
    await pipeline.approve(id, "refs_approved");
    await waitStatus(id, "refs_approved");

    // Break TTS for exactly one scene.
    const scenes = await ctx.ds.getRepository(Scene).find({ where: { projectId: id }, order: { idx: "ASC" } });
    const badText = scenes[3].narration;
    const real = ctx.providers.tts;
    let broken = true;
    const flaky: TtsProvider = {
      id: real.id,
      synthesize: async (req) => {
        if (broken && req.text === badText) throw new Error("synthetic TTS outage");
        return new MockTts().synthesize(req);
      },
    };
    ctx.providers.tts = flaky;

    await pipeline.run(id, "voiced");
    await waitFor("failed scene recorded", async () => {
      const s = await ctx.ds.getRepository(Scene).findOneByOrFail({ id: scenes[3].id });
      return s.status === "failed" && /synthetic TTS outage/.test(s.error ?? "");
    });
    const mid = await ctx.ds.getRepository(Scene).find({ where: { projectId: id } });
    expect(mid.filter((s) => s.audioAssetId).length).toBe(scenes.length - 1); // the others finished
    expect(await status(id)).toBe("refs_approved"); // waiting at the stage, not failed
    expect((await ctx.ds.getRepository(Job).findOneByOrFail({ projectId: id, sceneId: scenes[3].id, stage: "voice" })).attempts).toBe(3);

    broken = false;
    await pipeline.retry(id);
    await waitStatus(id, "voiced");
    const done = await ctx.ds.getRepository(Scene).findOneByOrFail({ id: scenes[3].id });
    expect(done.audioAssetId).toBeTruthy();
    expect(done.errors.voice).toBeUndefined();
    ctx.providers.tts = real;
  });

  it("serves only validated storage keys", () => {
    expect(() => ctx.storage.resolve("../etc/passwd")).toThrow();
    expect(() => ctx.storage.resolve("projects/x/../../y")).toThrow();
    expect(ctx.storage.resolve("projects/abc/out/final.mp4")).toContain("final.mp4");
  });
});
