/** Per-scene video segments (spec 9.1): Ken Burns from a still, or an AI clip fitted to length. */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { Camera } from "@vp/shared";
import type { CameraDefaults } from "../style";
import { runFfmpeg, probe } from "./exec";
import { overlayFilter } from "./overlay";

export interface Encode {
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
}

export const FINAL_ENCODE: Encode = { width: 1920, height: 1080, fps: 30, crf: 14, preset: "medium" };
export const DRAFT_ENCODE: Encode = { width: 960, height: 540, fps: 30, crf: 28, preset: "veryfast" };

const num = (n: number) => Number(n.toFixed(6)).toString();

/** bump when the Ken Burns filter changes so cached segments are re-rendered */
export const KEN_BURNS_VERSION = "kb3-static-fast";
/** zoompan renders at this multiple of the output size, then is scaled down (anti-shake). */
const KEN_BURNS_SUPERSAMPLE = 2;
/** prescale = output width x this, unless a caller overrides it */
const KEN_BURNS_PRESCALE = 4;

/**
 * Build the zoompan filter for a camera move. Progress uses the output frame
 * counter `on` (not an incremental zoom) so there is no drift, and the
 * expressions contain no commas (so no escaping is needed in -vf).
 */
export function kenBurnsFilter(
  camera: Camera,
  defaults: CameraDefaults,
  frames: number,
  enc: Encode,
  prescaleWidth: number,
): string {
  const F = Math.max(1, frames);
  const den = Math.max(1, F - 1);
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  let z: string;
  let x = centerX;
  let y = centerY;

  switch (camera) {
    case "push_in":
    case "pull_out": {
      const d = defaults[camera];
      z = `${num(d.zoomStart)}+(${num(d.zoomEnd - d.zoomStart)})*on/${den}`;
      break;
    }
    case "pan_left":
    case "pan_right": {
      const d = defaults[camera];
      z = num(d.zoom);
      x = `(iw-iw/zoom)*(${num(d.xFrom ?? 0.5)}+(${num((d.xTo ?? 0.5) - (d.xFrom ?? 0.5))})*on/${den})`;
      break;
    }
    case "tilt_up":
    case "tilt_down": {
      const d = defaults[camera];
      z = num(d.zoom);
      y = `(ih-ih/zoom)*(${num(d.yFrom ?? 0.5)}+(${num((d.yTo ?? 0.5) - (d.yFrom ?? 0.5))})*on/${den})`;
      break;
    }
    default:
      z = "1";
  }
  // zoompan snaps its crop window to whole input pixels, which shows up as a slight shake on slow
  // moves. Work on a much larger grid (prescale) and let zoompan output SS times the final size,
  // then scale down: the snapping error becomes a fraction of an output pixel and is averaged out.
  const ss = KEN_BURNS_SUPERSAMPLE;
  // a still camera has nothing to snap, so it needs no large prescale grid
  const pre = camera === "static" ? enc.width * ss : prescaleWidth;
  return [
    `scale=${pre}:-2:flags=lanczos`,
    `zoompan=z='${z}':x='${x}':y='${y}':d=${F}:s=${enc.width * ss}x${enc.height * ss}:fps=${enc.fps}`,
    `scale=${enc.width}:${enc.height}:flags=lanczos`,
    "format=yuv420p",
    "setsar=1",
    "settb=AVTB",
  ].join(",");
}

export interface SegmentJob {
  out: string;
  frames: number;
  camera: Camera;
  imagePath: string;
  clipPath?: string;
  /** transparent PNG with the on-screen text, same size as the output (optional) */
  overlayPng?: string;
  /** hash of everything that affects the output; enables incremental renders */
  cacheKey?: string;
}

export interface SegmentContext {
  enc: Encode;
  cameraDefaults: CameraDefaults;
  /** width the still is scaled to before zoompan (default 4x the output width; more reduces shake) */
  prescaleWidth?: number;
}

export function hashKey(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function cacheHit(out: string, key: string | undefined): Promise<boolean> {
  if (!key) return false;
  try {
    const [k] = await Promise.all([fs.readFile(out + ".key", "utf8"), fs.access(out)]);
    return k === key;
  } catch {
    return false;
  }
}

async function writeKey(out: string, key: string | undefined): Promise<void> {
  if (key) await fs.writeFile(out + ".key", key);
}

const x264 = (enc: Encode) => ["-c:v", "libx264", "-crf", String(enc.crf), "-preset", enc.preset, "-pix_fmt", "yuv420p", "-r", String(enc.fps), "-an"];

export async function renderStillSegment(job: SegmentJob, ctx: SegmentContext): Promise<void> {
  if (await cacheHit(job.out, job.cacheKey)) return;
  const prescale = ctx.prescaleWidth ?? ctx.enc.width * KEN_BURNS_PRESCALE;
  const vf = kenBurnsFilter(job.camera, ctx.cameraDefaults, job.frames, ctx.enc, prescale);
  if (job.overlayPng) {
    const graph = `[0:v]${vf}[bg];${overlayFilter(job.frames, ctx.enc.fps)};[bg][ov]overlay=0:0:format=auto,format=yuv420p[v]`;
    await runFfmpeg([
      "-i", job.imagePath, "-loop", "1", "-framerate", String(ctx.enc.fps), "-i", job.overlayPng,
      "-filter_complex", graph, "-map", "[v]", "-frames:v", String(job.frames), ...x264(ctx.enc), job.out,
    ]);
  } else {
    // The still is fed ONCE: `-loop 1` together with zoompan would multiply frames.
    await runFfmpeg(["-i", job.imagePath, "-vf", vf, "-frames:v", String(job.frames), ...x264(ctx.enc), job.out]);
  }
  await writeKey(job.out, job.cacheKey);
}

/**
 * Fit an AI clip to exactly `frames` frames (spec 6.6): trim if long, slow by
 * up to 15% if slightly short, otherwise ping-pong then hold the last frame.
 */
export async function renderClipSegment(job: SegmentJob, ctx: SegmentContext): Promise<void> {
  if (!job.clipPath) throw new Error("clipPath required");
  if (await cacheHit(job.out, job.cacheKey)) return;
  const { enc } = ctx;
  const targetSec = job.frames / enc.fps;
  const info = await probe(job.clipPath);
  const clipSec = info.video?.durationSec ?? info.durationSec;
  const fit = `scale=${enc.width}:${enc.height}:force_original_aspect_ratio=increase,crop=${enc.width}:${enc.height},setsar=1`;
  const tail = `fps=${enc.fps},format=yuv420p,settb=AVTB`;

  let graph: string;
  if (clipSec >= targetSec) {
    graph = `[0:v]${fit},${tail},trim=end_frame=${job.frames},setpts=PTS-STARTPTS[vb]`;
  } else if (clipSec / targetSec >= 0.85) {
    graph = `[0:v]${fit},setpts=PTS*${num(targetSec / clipSec)},${tail},trim=end_frame=${job.frames},setpts=PTS-STARTPTS[vb]`;
  } else {
    const hold = Math.max(0, targetSec - clipSec * 2);
    graph =
      `[0:v]${fit},${tail},split=2[f][b];[b]reverse[r];[f][r]concat=n=2:v=1:a=0,` +
      `tpad=stop_mode=clone:stop_duration=${num(hold + 0.5)},trim=end_frame=${job.frames},setpts=PTS-STARTPTS[vb]`;
  }
  const inputs = ["-i", job.clipPath];
  if (job.overlayPng) {
    graph += `;${overlayFilter(job.frames, enc.fps)};[vb][ov]overlay=0:0:format=auto,format=yuv420p[v]`;
    inputs.push("-loop", "1", "-framerate", String(enc.fps), "-i", job.overlayPng);
  } else {
    graph += ";[vb]null[v]";
  }
  await runFfmpeg([...inputs, "-filter_complex", graph, "-map", "[v]", "-frames:v", String(job.frames), ...x264(enc), job.out]);
  await writeKey(job.out, job.cacheKey);
}
