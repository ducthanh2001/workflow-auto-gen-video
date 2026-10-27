/** Audio: narration track, music bed, ducking, loudness (spec 9.3). */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Timeline } from "../timeline";
import { runFfmpeg, probe } from "./exec";
import { mapLimit } from "./util";

export const SAMPLE_RATE = 48000;

const s6 = (n: number) => Number(n.toFixed(6)).toString();

/** Pad each scene WAV to its slot, concatenate, delay the whole track by T/2. */
export async function buildNarration(opts: {
  tl: Timeline;
  audioPaths: string[];
  workDir: string;
  out: string;
  concurrency?: number;
}): Promise<void> {
  const { tl, audioPaths, workDir, out } = opts;
  if (audioPaths.length !== tl.scenes.length) throw new Error("one audio file per scene is required");
  const padDir = path.join(workDir, "audio_padded");
  await fs.mkdir(padDir, { recursive: true });

  const padded = await mapLimit(tl.scenes, opts.concurrency ?? 4, async (sc, i) => {
    const target = path.join(padDir, `s${String(i + 1).padStart(4, "0")}.wav`);
    const samples = Math.round(sc.slotSec * SAMPLE_RATE);
    await runFfmpeg([
      "-i", audioPaths[i],
      "-af", `aresample=${SAMPLE_RATE},aformat=channel_layouts=mono,adelay=${s6(tl.config.lead * 1000)}:all=1,apad=whole_len=${samples},atrim=end_sample=${samples}`,
      "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", target,
    ]);
    return target;
  });

  const listPath = path.join(padDir, "list.txt");
  const esc = (p: string) => p.replace(/\\/g, "/").replace(/'/g, "'\\''");
  await fs.writeFile(listPath, padded.map((p) => `file '${esc(p)}'`).join("\n") + "\n");
  await runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-af", `adelay=${s6(tl.audioDelaySec * 1000)}:all=1`,
    "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", out,
  ]);
}

export interface MusicOptions {
  path: string;
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  crossfadeSec?: number;
}

/** Loop (with acrossfade) / trim the track to the video length, apply gain and fades. */
export async function buildMusicBed(opts: MusicOptions & { totalSec: number; out: string }): Promise<void> {
  const cf = opts.crossfadeSec ?? 2;
  const info = await probe(opts.path);
  const d = info.audio?.durationSec ?? info.durationSec;
  if (!(d > 0)) throw new Error("music track has no duration");

  let copies = 1;
  if (d < opts.totalSec) {
    if (d <= cf * 2) throw new Error(`music track too short to loop (${d.toFixed(1)}s)`);
    copies = Math.ceil((opts.totalSec - cf) / (d - cf));
    if (copies > 200) throw new Error("music track too short for this video");
  }
  const inputs = Array.from({ length: copies }, () => ["-i", opts.path]).flat();
  const parts: string[] = [];
  let cur = "[0:a]";
  for (let i = 1; i < copies; i++) {
    parts.push(`${cur}[${i}:a]acrossfade=d=${cf}:c1=tri:c2=tri[x${i}]`);
    cur = `[x${i}]`;
  }
  const fadeOutStart = Math.max(0, opts.totalSec - opts.fadeOutSec);
  parts.push(
    `${cur}aresample=${SAMPLE_RATE},aformat=channel_layouts=stereo,atrim=end=${s6(opts.totalSec)},asetpts=PTS-STARTPTS,` +
      `volume=${opts.gainDb}dB,afade=t=in:st=0:d=${opts.fadeInSec},afade=t=out:st=${s6(fadeOutStart)}:d=${opts.fadeOutSec}[m]`,
  );
  await runFfmpeg([...inputs, "-filter_complex", parts.join(";"), "-map", "[m]", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", opts.out]);
}

/** Duck the music under narration (sidechain) and mix. `amix normalize=0` needs ffmpeg 7.x (doctor-checked). */
export async function mixAudio(opts: {
  narrationPath: string;
  musicPath?: string | null;
  out: string;
  /** write the ducked music stem here (debug / tests) */
  duckedStemOut?: string;
  legacyAmixGain?: boolean;
}): Promise<void> {
  if (!opts.musicPath) {
    await runFfmpeg([
      "-i", opts.narrationPath, "-af", `aformat=channel_layouts=stereo`,
      "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", opts.out,
    ]);
    return;
  }
  const norm = opts.legacyAmixGain ? "" : ":normalize=0";
  const post = opts.legacyAmixGain ? ",volume=2" : "";
  const stem = opts.duckedStemOut;
  const graph = [
    "[0:a]aformat=channel_layouts=stereo,asplit=2[narr_mix][narr_sc]",
    "[1:a]aformat=channel_layouts=stereo[music]",
    "[music][narr_sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=500[ducked]",
    stem ? "[ducked]asplit=2[ducked_a][ducked_stem]" : "[ducked]anull[ducked_a]",
    `[narr_mix][ducked_a]amix=inputs=2:duration=first${norm}${post}[mix]`,
  ].join(";");
  const maps = ["-map", "[mix]", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", opts.out];
  if (stem) maps.push("-map", "[ducked_stem]", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", stem);
  await runFfmpeg(["-i", opts.narrationPath, "-i", opts.musicPath, "-filter_complex", graph, ...maps]);
}

export interface Loudness {
  inputI: number;
  inputTP: number;
  inputLRA: number;
  inputThresh: number;
  targetOffset: number;
}

export function parseLoudnormJson(stderr: string): Loudness {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!m) throw new Error("loudnorm produced no measurement");
  const j = JSON.parse(m[m.length - 1]) as Record<string, string>;
  return {
    inputI: Number(j.input_i),
    inputTP: Number(j.input_tp),
    inputLRA: Number(j.input_lra),
    inputThresh: Number(j.input_thresh),
    targetOffset: Number(j.target_offset),
  };
}

/** Two-pass loudnorm on the final mix (spec 9.3 step 5). */
export async function normalizeLoudness(opts: {
  input: string;
  out: string;
  targetLufs: number;
  truePeak: number;
  lra: number;
}): Promise<{ before: Loudness }> {
  const base = `loudnorm=I=${opts.targetLufs}:TP=${opts.truePeak}:LRA=${opts.lra}`;
  const { stderr } = await runFfmpeg(
    ["-i", opts.input, "-af", `${base}:print_format=json`, "-f", "null", "-"],
    { loglevel: "info" },
  );
  const m = parseLoudnormJson(stderr);
  await runFfmpeg([
    "-i", opts.input,
    "-af",
    `${base}:measured_I=${m.inputI}:measured_LRA=${m.inputLRA}:measured_TP=${m.inputTP}:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true,aresample=${SAMPLE_RATE}`,
    "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", opts.out,
  ]);
  return { before: m };
}
