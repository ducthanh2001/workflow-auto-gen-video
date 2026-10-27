/** Crossfade joins (spec 9.2): used for scenes -> chunk and chunk -> full video. */
import { promises as fs } from "node:fs";
import type { TransitionOut } from "@vp/shared";
import { runFfmpeg } from "./exec";
import type { Encode } from "./segment";

export interface JoinStep {
  transition: TransitionOut;
  fadeSec: number;
  /** xfade offset (seconds) relative to the start of the chain; ignored for cuts */
  offsetSec: number;
  /** exact number of frames the chain must have after this join (offset + length of the next input) */
  outFrames: number;
}

const XFADE_NAME: Record<TransitionOut, string> = {
  cut: "fade",
  fade: "fade",
  fadeblack: "fadeblack",
  dissolve: "dissolve",
};

const s6 = (n: number) => Number(n.toFixed(6)).toString();

/**
 * Build the filter_complex that chains `joins.length + 1` inputs. A fade uses
 * xfade at `offsetSec`; a cut is a plain concat (so any mix of both is exact).
 */
export function buildJoinGraph(joins: JoinStep[], fps: number): { graph: string; out: string } {
  const n = joins.length + 1;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[p${i}]`);
  }
  let cur = "p0";
  joins.forEach((j, k) => {
    const next = `p${k + 1}`;
    const label = `o${k}`;
    // ffmpeg 6 and 7 differ in how xfade/fps end a stream (7.x emits one frame fewer). Pad with a held
    // last frame and cut to the planned length, so every stage has exactly the frames the timeline
    // expects and a cut can never land a frame early.
    const exact = `,settb=AVTB,fps=${fps},tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${j.outFrames},setpts=PTS-STARTPTS,fps=${fps}`;
    if (j.fadeSec > 0 && j.transition !== "cut") {
      parts.push(
        `[${cur}][${next}]xfade=transition=${XFADE_NAME[j.transition]}:duration=${s6(j.fadeSec)}:offset=${s6(j.offsetSec)}${exact}[${label}]`,
      );
    } else {
      parts.push(`[${cur}][${next}]concat=n=2:v=1:a=0${exact}[${label}]`);
    }
    cur = label;
  });
  return { graph: parts.join(";"), out: cur };
}

export interface JoinJob {
  inputs: string[];
  joins: JoinStep[];
  out: string;
  /** exact number of frames the result must have */
  frames: number;
  enc: Encode;
  cacheKey?: string;
}

export async function renderJoin(job: JoinJob): Promise<void> {
  if (job.inputs.length !== job.joins.length + 1) throw new Error("joins must be inputs - 1");
  if (job.cacheKey) {
    try {
      if ((await fs.readFile(job.out + ".key", "utf8")) === job.cacheKey) {
        await fs.access(job.out);
        return;
      }
    } catch {
      /* miss */
    }
  }
  if (job.inputs.length === 1) {
    await runFfmpeg([
      "-i", job.inputs[0], "-frames:v", String(job.frames),
      "-c:v", "libx264", "-crf", String(job.enc.crf), "-preset", job.enc.preset, "-pix_fmt", "yuv420p", "-an", job.out,
    ]);
  } else {
    const { graph, out } = buildJoinGraph(job.joins, job.enc.fps);
    const args = job.inputs.flatMap((p) => ["-i", p]);
    await runFfmpeg([
      ...args, "-filter_complex", graph, "-map", `[${out}]`, "-frames:v", String(job.frames),
      "-c:v", "libx264", "-crf", String(job.enc.crf), "-preset", job.enc.preset, "-pix_fmt", "yuv420p", "-r", String(job.enc.fps), "-an", job.out,
    ]);
  }
  if (job.cacheKey) await fs.writeFile(job.out + ".key", job.cacheKey);
}
