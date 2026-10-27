/** Render orchestration (spec 6.7, 9.1 to 9.4). Framework-free: takes file paths, returns file paths. */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Camera, Motion } from "@vp/shared";
import { planChunks, type Timeline } from "../timeline";
import type { CameraDefaults } from "../style";
import { runFfmpeg, probe } from "./exec";
import { DRAFT_ENCODE, FINAL_ENCODE, KEN_BURNS_VERSION, hashKey, renderClipSegment, renderStillSegment, type Encode } from "./segment";
import { renderJoin, type JoinStep } from "./chunk";
import { buildMusicBed, buildNarration, mixAudio, normalizeLoudness, type Loudness, type MusicOptions } from "./audio";
import { mapLimit } from "./util";
import { cleanOverlayText, renderTextOverlay } from "./overlay";

export * from "./exec";
export * from "./segment";
export * from "./chunk";
export * from "./audio";
export { mapLimit } from "./util";
export * from "./overlay";

export interface RenderScene {
  imagePath: string;
  clipPath?: string;
  audioPath: string;
  camera: Camera;
  motion: Motion;
  /** short label drawn over the picture with a fade (optional, rare) */
  onScreenText?: string | null;
  /** hash of the scene's inputs (asset cache keys) for incremental re-render */
  cacheKey?: string;
}

export interface RenderInput {
  workDir: string;
  mode: "draft" | "final";
  timeline: Timeline;
  scenes: RenderScene[];
  cameraDefaults: CameraDefaults;
  captions?: { assText: string; fontsDir: string } | null;
  /** font used to draw `onScreenText` labels (e.g. assets/fonts/Anton-Regular.ttf) */
  overlayFontPath?: string;
  music?: MusicOptions | null;
  audio?: { targetLufs: number; truePeak: number; lra: number };
  chunkSize?: number;
  concurrency?: number;
  /** override the ken-burns prescale width (default 2x output width) */
  prescaleWidth?: number;
  /** override encodes (tests use faster presets) */
  encode?: Partial<Encode>;
  /** keep the ducked music stem for inspection */
  keepStems?: boolean;
  legacyAmixGain?: boolean;
  onProgress?: (p: { stage: string; done: number; total: number }) => void;
}

export interface RenderOutput {
  videoPath: string;
  narrationPath: string;
  mixPath: string;
  duckedStemPath?: string;
  captionsAssPath?: string;
  totalSec: number;
  totalFrames: number;
  loudnessBefore?: Loudness;
  /** scene indexes where an AI clip failed and a Ken Burns still was used */
  clipFallbacks: number[];
}

const DEFAULT_AUDIO = { targetLufs: -14, truePeak: -1.5, lra: 11 };

export async function renderProject(input: RenderInput): Promise<RenderOutput> {
  const { timeline: tl, workDir, mode } = input;
  if (input.scenes.length !== tl.scenes.length) throw new Error("scenes and timeline length differ");
  const base = mode === "draft" ? DRAFT_ENCODE : FINAL_ENCODE;
  const enc: Encode = { ...base, fps: tl.config.fps, ...input.encode };
  const fps = enc.fps;
  const progress = input.onProgress ?? (() => undefined);
  const conc = input.concurrency ?? 3;

  const segDir = path.join(workDir, `segments_${mode}`);
  const chunkDir = path.join(workDir, `chunks_${mode}`);
  const audioDir = path.join(workDir, "audio");
  await Promise.all([segDir, chunkDir, audioDir].map((d) => fs.mkdir(d, { recursive: true })));

  // 1. Segments (one per scene) ------------------------------------------------
  const clipFallbacks: number[] = [];
  /** per-scene signature of everything that shapes its segment; feeds the chunk and join cache keys */
  const segSigs: string[] = [];
  let done = 0;
  const segPaths = await mapLimit(tl.scenes, conc, async (sc, i) => {
    const rs = input.scenes[i];
    const out = path.join(segDir, `s${String(i + 1).padStart(4, "0")}.mp4`);
    const ctx = { enc, cameraDefaults: input.cameraDefaults, prescaleWidth: input.prescaleWidth };
    let overlayPng: string | undefined;
    const label = rs.onScreenText ? cleanOverlayText(rs.onScreenText) : "";
    if (label && input.overlayFontPath) {
      overlayPng = path.join(segDir, `s${String(i + 1).padStart(4, "0")}-text.png`);
      await fs.writeFile(overlayPng, await renderTextOverlay({ text: label, fontPath: input.overlayFontPath, width: enc.width, height: enc.height }));
    }
    const useClip = mode === "final" && rs.motion === "ai_clip" && !!rs.clipPath;
    const keyBase = [rs.cacheKey ?? rs.imagePath, rs.camera, sc.segmentFrames, enc, label, KEN_BURNS_VERSION];
    segSigs[i] = hashKey(keyBase, useClip ? rs.clipPath : null);
    if (useClip) {
      try {
        await renderClipSegment(
          { out, frames: sc.segmentFrames, camera: rs.camera, imagePath: rs.imagePath, clipPath: rs.clipPath, overlayPng, cacheKey: hashKey("clip", rs.clipPath, ...keyBase) },
          ctx,
        );
      } catch {
        clipFallbacks.push(i);
        await renderStillSegment(
          { out, frames: sc.segmentFrames, camera: rs.camera, imagePath: rs.imagePath, overlayPng, cacheKey: hashKey("still", ...keyBase) },
          ctx,
        );
      }
    } else {
      await renderStillSegment(
        { out, frames: sc.segmentFrames, camera: rs.camera, imagePath: rs.imagePath, overlayPng, cacheKey: hashKey("still", ...keyBase) },
        ctx,
      );
    }
    progress({ stage: "segments", done: ++done, total: tl.scenes.length });
    return out;
  });

  // 2. Chunks of scenes, then chunk join ---------------------------------------
  const chunks = planChunks(tl, input.chunkSize ?? 12);
  const chunkPaths: string[] = [];
  const chunkKeys: string[] = [];
  let chunkDone = 0;
  for (const ch of chunks) {
    const out = path.join(chunkDir, `chunk_${String(ch.index + 1).padStart(3, "0")}.mp4`);
    const joins: JoinStep[] = [];
    for (let k = ch.sceneStart; k < ch.sceneEnd - 1; k++) {
      const sc = tl.scenes[k];
      joins.push({
        transition: sc.transitionOut,
        fadeSec: sc.fadeFrames / fps,
        offsetSec: (tl.scenes[k + 1].startFrame - tl.scenes[ch.sceneStart].startFrame) / fps,
        outFrames: tl.scenes[k + 1].startFrame - tl.scenes[ch.sceneStart].startFrame + tl.scenes[k + 1].segmentFrames,
      });
    }
    const inputs = segPaths.slice(ch.sceneStart, ch.sceneEnd);
    const chunkKey = hashKey("chunk", inputs.map((p, i) => [p, tl.scenes[ch.sceneStart + i].segmentFrames, segSigs[ch.sceneStart + i]]), joins, enc);
    await renderJoin({
      inputs, joins, out, frames: ch.frames, enc: { ...enc, crf: Math.min(enc.crf, 14) },
      cacheKey: chunkKey,
    });
    chunkPaths.push(out);
    chunkKeys.push(chunkKey);
    progress({ stage: "chunks", done: ++chunkDone, total: chunks.length });
  }

  const videoAll = path.join(workDir, `video_all_${mode}.mp4`);
  const chunkJoins: JoinStep[] = chunks.slice(0, -1).map((ch, i) => ({
    transition: ch.transitionOut,
    fadeSec: ch.fadeFrames / fps,
    offsetSec: tl.scenes[ch.sceneEnd].startFrame / fps, // absolute A_{k+1}
    outFrames: tl.scenes[ch.sceneEnd].startFrame + chunks[i + 1].frames,
  }));
  await renderJoin({
    inputs: chunkPaths, joins: chunkJoins, out: videoAll, frames: tl.totalFrames, enc: { ...enc, crf: Math.min(enc.crf, 14) },
    cacheKey: hashKey("all", chunkPaths, chunkKeys, chunkJoins, enc, chunks.map((c) => c.frames)),
  });

  // 3. Audio ---------------------------------------------------------------------
  const narrationPath = path.join(audioDir, "narration.wav");
  await buildNarration({ tl, audioPaths: input.scenes.map((s) => s.audioPath), workDir: audioDir, out: narrationPath, concurrency: conc });
  // TTS levels vary per voice/model. Normalize the narration bus so the sidechain
  // threshold (and therefore the ducking depth) is the same for every project.
  const narrationNormPath = path.join(audioDir, "narration_norm.wav");
  await normalizeLoudness({ input: narrationPath, out: narrationNormPath, targetLufs: -18, truePeak: -3, lra: 11 });
  progress({ stage: "narration", done: 1, total: 1 });

  let musicPath: string | null = null;
  if (input.music) {
    musicPath = path.join(audioDir, "music_bed.wav");
    await buildMusicBed({ ...input.music, totalSec: tl.totalSec, out: musicPath });
  }
  const mixRaw = path.join(audioDir, "mix_raw.wav");
  const duckedStemPath = input.keepStems && musicPath ? path.join(audioDir, "music_ducked.wav") : undefined;
  await mixAudio({ narrationPath: narrationNormPath, musicPath, out: mixRaw, duckedStemOut: duckedStemPath, legacyAmixGain: input.legacyAmixGain });

  const mixPath = path.join(audioDir, "mix_final.wav");
  const a = input.audio ?? DEFAULT_AUDIO;
  const { before } = await normalizeLoudness({ input: mixRaw, out: mixPath, targetLufs: a.targetLufs, truePeak: a.truePeak, lra: a.lra });
  progress({ stage: "audio", done: 1, total: 1 });

  // 4. Burn captions and mux in one video encode ---------------------------------
  const outName = mode === "draft" ? "draft.mp4" : "final.mp4";
  const videoPath = path.join(workDir, outName);
  let captionsAssPath: string | undefined;
  const vfParts: string[] = [];
  if (input.captions) {
    // Run ffmpeg with cwd = workDir and RELATIVE names, so no Windows drive-letter
    // colons or user text ever reach the filter string.
    captionsAssPath = path.join(workDir, "captions.ass");
    await fs.writeFile(captionsAssPath, input.captions.assText, "utf8");
    const fontDst = path.join(workDir, "fonts");
    await fs.mkdir(fontDst, { recursive: true });
    for (const f of await fs.readdir(input.captions.fontsDir)) {
      if (/\.(ttf|otf)$/i.test(f)) await fs.copyFile(path.join(input.captions.fontsDir, f), path.join(fontDst, f));
    }
    vfParts.push("ass=captions.ass:fontsdir=fonts");
  }
  const preset = mode === "draft" ? enc.preset : (input.encode?.preset ?? "slow");
  const crf = mode === "draft" ? enc.crf : (input.encode?.crf ?? 18);
  await runFfmpeg(
    [
      "-i", videoAll, "-i", mixPath,
      ...(vfParts.length ? ["-vf", vfParts.join(",")] : []),
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-crf", String(crf), "-preset", preset, "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart", "-t", tl.totalSec.toFixed(6), videoPath,
    ],
    { cwd: workDir },
  );
  progress({ stage: "mux", done: 1, total: 1 });

  // Sanity: the muxed file must match the timeline (spec 17, within 1 frame).
  const info = await probe(videoPath);
  if (info.video && Math.abs(info.video.durationSec - tl.totalFrames / fps) > 2 / fps) {
    throw new Error(`rendered video is ${info.video.durationSec}s, expected ${tl.totalFrames / fps}s`);
  }

  return {
    videoPath, narrationPath, mixPath, duckedStemPath, captionsAssPath,
    totalSec: tl.totalSec, totalFrames: tl.totalFrames, loudnessBefore: before, clipFallbacks: clipFallbacks.sort((x, y) => x - y),
  };
}
