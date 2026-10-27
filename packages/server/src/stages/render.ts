import path from "node:path";
import { promises as fs } from "node:fs";
import { In } from "typeorm";
import {
  buildCues, buildTimeline, renderProject, toAss, toSrt, probe, requireLicenseNote,
  type RenderScene,
} from "@vp/core";
import { Asset, MusicTrack, Project } from "../entities";
import { projectKey } from "../storage";
import { fatal, loadProject, loadScenes, type StageFn } from "./common";

/** Timeline, render, captions, music (spec 6.7 and 9). `render_draft` and `render_final` share this. */
export const renderStage: StageFn = async (ctx, data) => {
  const mode = data.stage === "render_draft" ? "draft" : "final";
  const project = await loadProject(ctx, data.projectId);
  const scenes = await loadScenes(ctx, project.id);
  if (!scenes.length) throw fatal("nothing to render: the project has no scenes");
  const style = ctx.cfg.styles[project.settings.style];
  if (!style) throw fatal(`unknown style "${project.settings.style}"`);

  const missing = scenes.filter((s) => !s.audioAssetId || !s.imageAssetId || !s.audioDurationSec).map((s) => s.idx + 1);
  if (missing.length) throw fatal(`scenes missing audio or image: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? "..." : ""}`);

  const assetIds = scenes.flatMap((s) => [s.audioAssetId!, s.imageAssetId!, ...(s.clipAssetId ? [s.clipAssetId] : [])]);
  const assets = new Map((await ctx.ds.getRepository(Asset).findBy({ id: In(assetIds) })).map((a) => [a.id, a]));
  const abs = (id: string) => ctx.storage.resolve(assets.get(id)!.storageKey);

  const tcfg = ctx.cfg.providers.timeline;
  const timeline = buildTimeline(
    scenes.map((s) => ({ beat: s.beat, audioSec: s.audioDurationSec!, transitionOut: s.transitionOut })),
    { fps: project.settings.fps, lead: tcfg.lead, tail: tcfg.tail, tailBeat: tcfg.tailBeat, transition: project.settings.transitionSec },
  );

  const cues = buildCues(timeline, scenes.map((s) => s.narration), style.captions);
  const srt = toSrt(cues);
  const assText = toAss(cues, style.captions);

  let music = null;
  if (project.settings.musicTrackId) {
    const track = await ctx.ds.getRepository(MusicTrack).findOneBy({ id: project.settings.musicTrackId });
    if (!track) throw fatal("the selected music track no longer exists");
    requireLicenseNote(track.licenseNote);
    const a = ctx.cfg.providers.audio;
    music = { path: ctx.storage.resolve(track.storageKey), gainDb: a.musicGainDb, fadeInSec: a.musicFadeIn, fadeOutSec: a.musicFadeOut };
  }

  const renderScenes: RenderScene[] = scenes.map((s) => ({
    imagePath: abs(s.imageAssetId!),
    clipPath: s.clipAssetId ? abs(s.clipAssetId) : undefined,
    audioPath: abs(s.audioAssetId!),
    camera: s.camera,
    motion: s.motion,
    onScreenText: s.onScreenText,
    cacheKey: [s.imageAssetId, s.clipAssetId ?? "", s.camera, s.motion].join(":"),
  }));

  const workDir = ctx.storage.resolve(projectKey(project.id, "work"));
  await fs.mkdir(workDir, { recursive: true });
  let lastPct = -1;
  const out = await renderProject({
    workDir, mode, timeline, scenes: renderScenes, cameraDefaults: style.camera_defaults,
    overlayFontPath: path.join(ctx.cfg.fontsDir, "Anton-Regular.ttf"),
    captions: project.settings.captions ? { assText, fontsDir: ctx.cfg.fontsDir } : null,
    music,
    audio: { targetLufs: ctx.cfg.providers.audio.targetLufs, truePeak: ctx.cfg.providers.audio.truePeak, lra: ctx.cfg.providers.audio.lra },
    chunkSize: tcfg.chunkSize,
    // RENDER_FAST=1 is for tests and quick local trials: smaller prescale, fastest x264 preset
    ...(ctx.cfg.env.RENDER_FAST === "1" ? { encode: { preset: "ultrafast", crf: 23 }, prescaleWidth: 1920 } : {}),
    concurrency: Math.max(1, Math.min(4, Math.floor((await import("node:os")).cpus().length / 2))),
    onProgress: (p) => {
      const pct = Math.floor((p.done / p.total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        void ctx.events.publish(project.id, "job", { stage: data.stage, progress: p.stage, done: p.done, total: p.total });
      }
    },
  });

  // Products: video, srt (always), ass.
  const repo = ctx.ds.getRepository(Asset);
  const dropOld = async (type: Asset["type"], where: Partial<Record<string, unknown>> = {}) => {
    const old = await repo.find({ where: { projectId: project.id, type } });
    for (const a of old) {
      if (Object.entries(where).every(([k, v]) => (a.params as Record<string, unknown>)[k] === v)) await repo.delete({ id: a.id });
    }
  };

  const info = await probe(out.videoPath);
  await dropOld("video", { mode });
  const videoKey = projectKey(project.id, "out", mode === "draft" ? "draft.mp4" : "final.mp4");
  const videoBytes = await ctx.storage.putFile(videoKey, out.videoPath);
  await ctx.assets.create({
    projectId: project.id, type: "video", storageKey: videoKey, mime: "video/mp4",
    params: {
      mode, width: info.video?.width, height: info.video?.height,
      videoSec: info.video?.durationSec, audioSec: info.audio?.durationSec,
      driftMs: info.video && info.audio ? Math.round(Math.abs(info.video.durationSec - info.audio.durationSec) * 1000) : null,
      loudnessBefore: out.loudnessBefore, clipFallbacks: out.clipFallbacks, scenes: scenes.length,
    },
    durationSec: info.durationSec, bytes: videoBytes,
  });

  await dropOld("srt");
  await ctx.assets.create({
    projectId: project.id, type: "srt", mime: "application/x-subrip", storageKey: projectKey(project.id, "out", "captions.en.srt"),
    bytes: await ctx.storage.put(projectKey(project.id, "out", "captions.en.srt"), Buffer.from(srt, "utf8")),
  });
  await dropOld("ass");
  await ctx.assets.create({
    projectId: project.id, type: "ass", mime: "text/x-ssa", storageKey: projectKey(project.id, "out", "captions.ass"),
    bytes: await ctx.storage.put(projectKey(project.id, "out", "captions.ass"), Buffer.from(assText, "utf8")),
  });

  // Register segments and chunks so the stale flags (spec 5) have something to point at.
  await repo.createQueryBuilder().delete().where('"projectId" = :id AND "type" IN (\'segment\',\'chunk\')', { id: project.id }).execute();
  const rel = (p: string) => `${projectKey(project.id, "work")}/${path.relative(workDir, p).split(path.sep).join("/")}`;
  const segDir = path.join(workDir, `segments_${mode}`);
  for (const [i, s] of scenes.entries()) {
    const f = path.join(segDir, `s${String(i + 1).padStart(4, "0")}.mp4`);
    await ctx.assets.create({ projectId: project.id, sceneId: s.id, type: "segment", storageKey: rel(f), mime: "video/mp4", params: { mode }, bytes: (await fs.stat(f)).size });
  }
  const chunkDir = path.join(workDir, `chunks_${mode}`);
  for (const f of (await fs.readdir(chunkDir)).filter((n) => n.endsWith(".mp4")).sort()) {
    await ctx.assets.create({ projectId: project.id, type: "chunk", storageKey: rel(path.join(chunkDir, f)), mime: "video/mp4", params: { mode }, bytes: (await fs.stat(path.join(chunkDir, f))).size });
  }
  await repo.update({ projectId: project.id, type: In(["music_mix"]) }, { stale: false });

  const fresh = await ctx.ds.getRepository(Project).findOneBy({ id: project.id });
  await ctx.ds.getRepository(Project).update(project.id, {
    stale: (fresh?.stale ?? []).filter((x) => x !== mode),
    meta: { ...(fresh?.meta ?? {}), clipFallbacks: out.clipFallbacks } as Project["meta"],
  });
  await ctx.events.publish(project.id, "asset", { kind: "video", mode });
  return { costUsd: 0, note: out.clipFallbacks.length ? `${out.clipFallbacks.length} clip fallback(s)` : undefined };
};
