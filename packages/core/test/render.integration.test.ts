/**
 * Offline integration test (spec 17): mock providers, full render, no API calls.
 * Needs ffmpeg/ffprobe (set FFMPEG_PATH / FFPROBE_PATH or have them on PATH).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { TransitionOut } from "@vp/shared";
import { buildTimeline, type Timeline } from "../src/timeline";
import { buildCues, toAss } from "../src/captions";
import { parseStyle } from "../src/style";
import {
  bins, probe, renderProject, runFfmpeg, runFfmpegStdout, parseLoudnormJson,
  type RenderOutput, type RenderScene,
} from "../src/render";

function hasFfmpeg(): boolean {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    execFileSync(bins.ffprobe, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const N = 12;
const TRANSITIONS: TransitionOut[] = [
  "fade", "cut", "dissolve", "fadeblack", "fade", "cut", "dissolve", "fadeblack", "fade", "cut", "fade", "fade",
];
const BEATS = ["Hook", "Hook", "Hook", "Hook", "Middle", "Middle", "Middle", "Middle", "End", "End", "End", "End"];
const NARRATIONS = Array.from({ length: N }, (_, i) =>
  `Scene number ${i + 1} speaks a few clear words so that the caption has something to show.`,
);
const AUDIO_SEC = Array.from({ length: N }, (_, i) => 3.37 + (i % 4) * 0.61);

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const sceneColor = (i: number) => hslToRgb(i * 30, 0.9, 0.6);

async function frameRgb(video: string, t: number, w = 96, h = 54): Promise<Buffer> {
  return runFfmpegStdout(["-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

/** mean colour of the top 60% of the frame (avoids the caption zone) */
function meanTop(buf: Buffer, w = 96, h = 54): [number, number, number] {
  const rows = Math.floor(h * 0.6);
  let r = 0, g = 0, b = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    r += buf[o]; g += buf[o + 1]; b += buf[o + 2];
  }
  const n = rows * w;
  return [r / n, g / n, b / n];
}

const luma = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** count near-white pixels in the bottom 30% (burned-in caption text) */
function whiteInCaptionZone(buf: Buffer, w: number, h: number): number {
  let n = 0;
  for (let y = Math.floor(h * 0.7); y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    if (buf[o] > 225 && buf[o + 1] > 225 && buf[o + 2] > 225) n++;
  }
  return n;
}

async function rmsWindow(file: string, startSec: number, durSec: number): Promise<number> {
  const raw = await runFfmpegStdout(["-ss", startSec.toFixed(3), "-t", durSec.toFixed(3), "-i", file, "-f", "s16le", "-ac", "1", "-ar", "48000", "-"]);
  const n = Math.floor(raw.length / 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = raw.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));

describe.skipIf(!hasFfmpeg())("offline render integration (spec 17)", () => {
  let dir: string;
  let tl: Timeline;
  let out: RenderOutput;
  let fonts: string;
  let musicBedPath: string;
  const FPS = 30;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-render-"));
    fonts = path.resolve(__dirname, "../../../assets/fonts");
    const assets = path.join(dir, "assets");
    await fs.mkdir(assets, { recursive: true });

    // mock images: solid colour per scene
    const scenes: RenderScene[] = [];
    for (let i = 0; i < N; i++) {
      const [r, g, b] = sceneColor(i);
      const img = path.join(assets, `img${i}.png`);
      await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r, g, b } } }).png().toFile(img);
      // mock narration: sine tone of known length, 24 kHz mono
      const wav = path.join(assets, `a${i}.wav`);
      await runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=${300 + i * 20}:duration=${AUDIO_SEC[i]}:sample_rate=24000`, "-af", "volume=0.35", "-ac", "1", wav]);
      scenes.push({ imagePath: img, audioPath: wav, camera: (["push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "static"] as const)[i % 7], motion: "kenburns", cacheKey: `scene-${i}` });
    }
    // scene 2: a short AI clip (2 s, shorter than its slot -> ping-pong + hold); scene 6: clip that fails -> fallback
    const clip = path.join(assets, "clip2.mp4");
    const [cr, cg, cb] = sceneColor(2);
    await runFfmpeg(["-f", "lavfi", "-i", `color=c=0x${[cr, cg, cb].map((v) => v.toString(16).padStart(2, "0")).join("")}:s=640x360:d=2:r=24`, "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    scenes[2] = { ...scenes[2], motion: "ai_clip", clipPath: clip };
    scenes[6] = { ...scenes[6], motion: "ai_clip", clipPath: path.join(assets, "does-not-exist.mp4") };

    // mock music: 22 s tone (shorter than the video, so it must loop)
    const music = path.join(assets, "music.wav");
    await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=110:duration=22:sample_rate=44100", "-af", "volume=0.9", "-ac", "2", music]);

    tl = buildTimeline(AUDIO_SEC.map((a, i) => ({ beat: BEATS[i], audioSec: a, transitionOut: TRANSITIONS[i] })));
    const style = parseStyle(await fs.readFile(path.resolve(__dirname, "../../../config/styles/warm-ink-cartoon.yaml"), "utf8"));
    const cues = buildCues(tl, NARRATIONS, style.captions);

    out = await renderProject({
      workDir: path.join(dir, "work"),
      mode: "final",
      timeline: tl,
      scenes,
      cameraDefaults: style.camera_defaults,
      captions: { assText: toAss(cues, style.captions), fontsDir: fonts },
      music: { path: music, gainDb: -18 + 12, fadeInSec: 2, fadeOutSec: 3 }, // +12 dB so the test tone is measurable
      chunkSize: 5,
      prescaleWidth: 1920,
      encode: { preset: "ultrafast", crf: 23 },
      keepStems: true,
    });
    musicBedPath = path.join(dir, "work", "audio", "music_bed.wav");
  });

  afterAll(async () => {
    if (dir && process.env.VP_KEEP) console.log("KEPT", dir);
    else if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("outputs 1920x1080 30 fps H.264 yuv420p and AAC 48 kHz", async () => {
    const info = await probe(out.videoPath);
    expect(info.video).toMatchObject({ width: 1920, height: 1080, codec: "h264", pixFmt: "yuv420p" });
    expect(info.video!.fps).toBeCloseTo(30, 2);
    expect(info.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
  });

  it("video duration == sum D + T/2 and audio matches video (A/V drift < 40 ms)", async () => {
    const info = await probe(out.videoPath);
    const expected = tl.scenes.reduce((a, s) => a + s.slotSec, 0) + tl.config.transition / 2;
    expect(Math.abs(info.video!.durationSec - expected)).toBeLessThanOrEqual(1 / FPS + 1e-3);
    expect(Math.abs(info.audio!.durationSec - info.video!.durationSec)).toBeLessThan(0.04);
  });

  it("falls back to Ken Burns when an AI clip fails", () => {
    expect(out.clipFallbacks).toEqual([6]);
  });

  it("scene frames change at the expected times", async () => {
    for (let i = 0; i < N; i++) {
      const sc = tl.scenes[i];
      const t = sc.startSec + (sc.slotSec + tl.config.transition) / 2;
      const got = meanTop(await frameRgb(out.videoPath, t));
      const want = sceneColor(i);
      expect(dist(got, want), `scene ${i + 1} colour at ${t.toFixed(2)}s`).toBeLessThan(30);
      // and it is closer to its own colour than to any other scene's
      for (let j = 0; j < N; j++) if (j !== i) expect(dist(got, want)).toBeLessThan(dist(got, sceneColor(j)));
    }
  });

  it("cuts land on the exact frame, also across chunk boundaries", async () => {
    // chunkSize is 5, so the join after scene index 4 is a chunk boundary (fade) and after index 9 a cut at a chunk boundary
    for (const k of [1, 5, 9]) {
      expect(tl.scenes[k].transitionOut).toBe("cut");
      const a = tl.scenes[k + 1].startFrame;
      // `-ss` before `-i` returns the first frame with pts >= the target, so aim half a frame before it
      const before = meanTop(await frameRgb(out.videoPath, (a - 1) / FPS - 1 / (2 * FPS)));
      const after = meanTop(await frameRgb(out.videoPath, a / FPS - 1 / (2 * FPS)));
      expect(dist(before, sceneColor(k)), `frame ${a - 1} still scene ${k + 1}`).toBeLessThan(30);
      expect(dist(after, sceneColor(k + 1)), `frame ${a} already scene ${k + 2}`).toBeLessThan(30);
    }
  });

  it("has no black frames at joins except fadeblack, which does reach black", async () => {
    // xfade's fadeblack reaches black early in the window (not at 50%), so take the
    // darkest frame over the whole join window [A_{k+1}, A_{k+1} + T].
    for (let k = 0; k < N - 1; k++) {
      const sc = tl.scenes[k];
      const a = tl.scenes[k + 1].startSec;
      const times = sc.transitionOut === "cut" ? [a - 0.04, a, a + 0.04] : Array.from({ length: 7 }, (_, j) => a + (j * tl.config.transition) / 6);
      let min = Infinity;
      for (const t of times) min = Math.min(min, luma(meanTop(await frameRgb(out.videoPath, t))));
      if (sc.transitionOut === "fadeblack") expect(min, `join ${k + 1} (fadeblack)`).toBeLessThan(25);
      else expect(min, `join ${k + 1} (${sc.transitionOut})`).toBeGreaterThan(60);
    }
  });

  it("burns captions inside the speech windows and not in the gaps", async () => {
    const W = 480, H = 270;
    for (let i = 0; i < N; i++) {
      const sc = tl.scenes[i];
      const during = whiteInCaptionZone(await frameRgb(out.videoPath, sc.speechStartSec + 0.3, W, H), W, H);
      expect(during, `scene ${i + 1} caption visible`).toBeGreaterThan(20);
      if (i < N - 1) {
        const gap = whiteInCaptionZone(await frameRgb(out.videoPath, sc.speechEndSec + 0.3, W, H), W, H);
        expect(gap, `scene ${i + 1} caption gone in gap`).toBe(0);
      }
    }
  });

  it("ducks the music at least 6 dB while narration is present", async () => {
    const speechRatios: number[] = [];
    const gapRatios: number[] = [];
    for (const i of [1, 2, 4, 5, 8, 9]) {
      const sc = tl.scenes[i];
      const s0 = sc.speechStartSec + 0.4;
      const ducked = await rmsWindow(out.duckedStemPath!, s0, sc.audioSec - 0.6);
      const bed = await rmsWindow(musicBedPath, s0, sc.audioSec - 0.6);
      speechRatios.push(db(ducked) - db(bed));
      // end of the gap before the next scene's speech (music has had time to recover)
      const gapStart = tl.scenes[i + 1].speechStartSec - 0.2;
      const gDucked = await rmsWindow(out.duckedStemPath!, gapStart, 0.15);
      const gBed = await rmsWindow(musicBedPath, gapStart, 0.15);
      gapRatios.push(db(gDucked) - db(gBed));
    }
    for (const r of speechRatios) expect(r).toBeLessThan(-6);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(gapRatios)).toBeGreaterThan(avg(speechRatios) + 3);
  });

  it("final integrated loudness is -14 LUFS +/- 1", async () => {
    const { stderr } = await runFfmpeg(["-i", out.videoPath, "-vn", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { loglevel: "info" });
    const m = parseLoudnormJson(stderr);
    expect(m.inputI).toBeGreaterThan(-15);
    expect(m.inputI).toBeLessThan(-13);
  });
});
