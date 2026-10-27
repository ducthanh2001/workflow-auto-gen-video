/**
 * Timeline and sync math (spec section 8).
 *
 * Slot boundaries are quantized to whole frames (cumulatively, so rounding
 * error never accumulates), which makes every xfade offset an exact multiple
 * of the frame duration.
 */
import type { TransitionOut } from "@vp/shared";

export interface TimelineConfig {
  fps: number;
  lead: number;
  tail: number;
  tailBeat: number;
  /** crossfade length T in seconds */
  transition: number;
}

export const DEFAULT_TIMELINE: TimelineConfig = {
  fps: 30,
  lead: 0.2,
  tail: 0.3,
  tailBeat: 0.6,
  transition: 0.4,
};

export interface TimelineSceneInput {
  beat: string;
  /** measured narration duration a_i (ffprobe), seconds */
  audioSec: number;
  /** transition into the NEXT scene (ignored for the last scene) */
  transitionOut: TransitionOut;
}

export interface SceneTiming {
  idx: number;
  beat: string;
  isBeatEnd: boolean;
  audioSec: number;
  /** slot length D_i */
  slotSec: number;
  /** slot start A_i in video time */
  startSec: number;
  /** transition into next scene and its length T_i (0 for cut / last scene) */
  transitionOut: TransitionOut;
  fadeSec: number;
  /** rendered segment length L_i */
  segmentSec: number;
  /** frame-exact counterparts */
  startFrame: number;
  slotFrames: number;
  fadeFrames: number;
  segmentFrames: number;
  /** xfade offset of the join after this scene (== A_{i+1}); undefined for last */
  joinOffsetSec?: number;
  joinOffsetFrame?: number;
  /** speech start S_i and end E_i in video time (narration is delayed by T/2) */
  speechStartSec: number;
  speechEndSec: number;
}

export interface Timeline {
  config: TimelineConfig;
  scenes: SceneTiming[];
  /** sum D_i + T/2 */
  totalSec: number;
  totalFrames: number;
  /** delay applied to the whole narration track (T/2) */
  audioDelaySec: number;
}

export function validateConfig(c: TimelineConfig): void {
  if (c.fps <= 0) throw new Error("fps must be positive");
  if (c.transition < 0) throw new Error("transition must be >= 0");
  if (c.transition > c.lead + c.tail - 0.1 + 1e-9) {
    throw new Error(
      `transition ${c.transition}s too long: require T <= LEAD + TAIL - 0.1 (${(c.lead + c.tail - 0.1).toFixed(2)}s)`,
    );
  }
}

export function buildTimeline(
  inputs: TimelineSceneInput[],
  cfg: Partial<TimelineConfig> = {},
): Timeline {
  const config = { ...DEFAULT_TIMELINE, ...cfg };
  validateConfig(config);
  if (inputs.length === 0) throw new Error("timeline needs at least one scene");
  const { fps, lead, tail, tailBeat } = config;
  const T = config.transition;
  const n = inputs.length;

  // Exact (unquantized) slot lengths and starts.
  const isBeatEnd = inputs.map((s, i) => i === n - 1 || inputs[i + 1].beat !== s.beat);
  const D = inputs.map((s, i) => {
    if (!(s.audioSec > 0)) throw new Error(`scene ${i + 1}: audio duration must be > 0`);
    return lead + s.audioSec + (isBeatEnd[i] ? tailBeat : tail);
  });
  const A: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    A.push(acc);
    acc += D[i];
  }
  const sumD = acc;

  // Frame quantization of boundaries (cumulative rounding -> no drift).
  const Af = A.map((a) => Math.round(a * fps));
  Af.push(Math.round(sumD * fps));
  const halfFadeFrames = Math.round((T / 2) * fps);

  const scenes: SceneTiming[] = inputs.map((s, i) => {
    const last = i === n - 1;
    const tr: TransitionOut = last ? "cut" : s.transitionOut;
    const fadeSec = last || tr === "cut" ? 0 : T;
    const fadeFrames = Math.round(fadeSec * fps);
    const slotFrames = Af[i + 1] - Af[i];
    const segmentFrames = last ? slotFrames + halfFadeFrames : slotFrames + fadeFrames;
    const speechStart = A[i] + T / 2 + lead;
    return {
      idx: i,
      beat: s.beat,
      isBeatEnd: isBeatEnd[i],
      audioSec: s.audioSec,
      slotSec: D[i],
      startSec: A[i],
      transitionOut: tr,
      fadeSec,
      segmentSec: segmentFrames / fps,
      startFrame: Af[i],
      slotFrames,
      fadeFrames,
      segmentFrames,
      joinOffsetSec: last ? undefined : Af[i + 1] / fps,
      joinOffsetFrame: last ? undefined : Af[i + 1],
      speechStartSec: speechStart,
      speechEndSec: speechStart + s.audioSec,
    };
  });

  return {
    config,
    scenes,
    totalSec: sumD + T / 2,
    totalFrames: Af[n] + halfFadeFrames,
    audioDelaySec: T / 2,
  };
}

/**
 * Split a timeline into chunks of `chunkSize` scenes (spec 9.2). A chunk is
 * the xfade chain of its scenes; its output is `sum(slotFrames)` plus the
 * trailing overlap of its last segment, so chunks join with the same formula.
 */
export interface ChunkPlan {
  index: number;
  sceneStart: number;
  /** exclusive */
  sceneEnd: number;
  /** frames of this chunk's output (includes the trailing overlap) */
  frames: number;
  /** join into the next chunk */
  transitionOut: TransitionOut;
  fadeFrames: number;
}

export function planChunks(tl: Timeline, chunkSize = 12): ChunkPlan[] {
  const out: ChunkPlan[] = [];
  const n = tl.scenes.length;
  for (let s = 0, k = 0; s < n; s += chunkSize, k++) {
    const e = Math.min(n, s + chunkSize);
    const last = tl.scenes[e - 1];
    let frames = 0;
    for (let i = s; i < e; i++) frames += tl.scenes[i].slotFrames;
    frames += last.segmentFrames - last.slotFrames;
    out.push({
      index: k,
      sceneStart: s,
      sceneEnd: e,
      frames,
      transitionOut: last.transitionOut,
      fadeFrames: last.fadeFrames,
    });
  }
  return out;
}
