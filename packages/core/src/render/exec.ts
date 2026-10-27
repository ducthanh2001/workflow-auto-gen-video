/**
 * Thin wrappers around ffmpeg/ffprobe. Always invoked with an argument array,
 * never through a shell string (spec 3.4).
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const bins = {
  get ffmpeg() {
    return process.env.FFMPEG_PATH || "ffmpeg";
  },
  get ffprobe() {
    return process.env.FFPROBE_PATH || "ffprobe";
  },
};

export class FfmpegError extends Error {
  constructor(message: string, public readonly args: string[], public readonly stderrTail: string) {
    super(`${message}\n--- ffmpeg stderr (tail) ---\n${stderrTail}`);
    this.name = "FfmpegError";
  }
}

export interface RunOptions {
  cwd?: string;
  /** ffmpeg -loglevel; use "info" when you need to parse filter output (loudnorm). */
  loglevel?: "error" | "warning" | "info";
  signal?: AbortSignal;
}

const TAIL_BYTES = 64 * 1024;

export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<{ stderr: string }> {
  const full = ["-hide_banner", "-nostdin", "-loglevel", opts.loglevel ?? "error", "-y", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(bins.ffmpeg, full, {
      cwd: opts.cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      signal: opts.signal,
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > TAIL_BYTES * 2) stderr = stderr.slice(-TAIL_BYTES);
    });
    child.on("error", (e) => reject(new FfmpegError(`failed to start ffmpeg: ${e.message}`, full, stderr.slice(-TAIL_BYTES))));
    child.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new FfmpegError(`ffmpeg exited with code ${code}`, full, stderr.slice(-TAIL_BYTES)));
    });
  });
}

/** Run ffmpeg and return raw stdout bytes (used to sample frames/PCM). */
export function runFfmpegStdout(args: string[], opts: RunOptions = {}): Promise<Buffer> {
  const full = ["-hide_banner", "-nostdin", "-loglevel", "error", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(bins.ffmpeg, full, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new FfmpegError(`ffmpeg exited with code ${code}`, full, stderr.slice(-TAIL_BYTES))),
    );
  });
}

export interface ProbeResult {
  durationSec: number;
  video?: { width: number; height: number; fps: number; codec: string; pixFmt: string; durationSec: number; frames?: number };
  audio?: { codec: string; sampleRate: number; channels: number; durationSec: number };
}

function parseFps(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split("/").map(Number);
  return b ? a / b : a;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await execFileP(
    bins.ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<Record<string, string | number | undefined>>;
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const fmtDur = Number(j.format?.duration ?? 0);
  return {
    durationSec: fmtDur,
    video: v
      ? {
          width: Number(v.width),
          height: Number(v.height),
          fps: parseFps(String(v.avg_frame_rate ?? v.r_frame_rate)),
          codec: String(v.codec_name),
          pixFmt: String(v.pix_fmt),
          durationSec: Number(v.duration ?? fmtDur),
          frames: v.nb_frames ? Number(v.nb_frames) : undefined,
        }
      : undefined,
    audio: a
      ? {
          codec: String(a.codec_name),
          sampleRate: Number(a.sample_rate),
          channels: Number(a.channels),
          durationSec: Number(a.duration ?? fmtDur),
        }
      : undefined,
  };
}

export interface VolumeStats {
  meanDb: number;
  maxDb: number;
}

/** Peak/mean level via volumedetect. Used to reject silent or clipped TTS (spec 6.4). */
export async function volumeDetect(file: string): Promise<VolumeStats> {
  const { stderr } = await runFfmpeg(["-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { loglevel: "info" });
  const mean = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr)?.[1];
  const max = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr)?.[1];
  const num = (s?: string) => (s === undefined || s === "-inf" ? -Infinity : Number(s));
  return { meanDb: num(mean), maxDb: num(max) };
}

export interface AudioCheck {
  ok: boolean;
  reason?: "silent" | "clipped";
  stats: VolumeStats;
}

export async function checkSpeechAudio(file: string): Promise<AudioCheck> {
  const stats = await volumeDetect(file);
  if (!(stats.maxDb > -45) || !(stats.meanDb > -60)) return { ok: false, reason: "silent", stats };
  if (stats.maxDb >= -0.05 && stats.meanDb > -12) return { ok: false, reason: "clipped", stats };
  return { ok: true, stats };
}

/** Run ffmpeg `-filters` and return which names exist (for the doctor check). */
export async function ffmpegCapabilities(): Promise<{
  version: string;
  filters: Record<string, boolean>;
  encoders: Record<string, boolean>;
  amixNormalize: boolean;
}> {
  const run = async (a: string[]) => {
    const { stdout } = await execFileP(bins.ffmpeg, ["-hide_banner", ...a], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return stdout;
  };
  const version = /ffmpeg version (\S+)/.exec(await run(["-version"]))?.[1] ?? "unknown";
  const filtersTxt = await run(["-filters"]);
  const encodersTxt = await run(["-encoders"]);
  const has = (txt: string, name: string) => new RegExp(`\\s${name}\\s`).test(txt);
  const names = ["xfade", "zoompan", "loudnorm", "sidechaincompress", "acrossfade", "amix", "ass", "concat", "apad", "adelay"];
  const filters = Object.fromEntries(names.map((n) => [n, has(filtersTxt, n)]));
  const encoders = { libx264: has(encodersTxt, "libx264"), aac: has(encodersTxt, "aac") };
  let amixNormalize = false;
  try {
    amixNormalize = /\bnormalize\b/.test(await run(["-h", "filter=amix"]));
  } catch {
    /* ignore */
  }
  return { version, filters, encoders, amixNormalize };
}
