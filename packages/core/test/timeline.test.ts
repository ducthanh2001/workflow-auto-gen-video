import { describe, it, expect } from "vitest";
import type { TransitionOut } from "@vp/shared";
import { buildTimeline, planChunks, type TimelineSceneInput } from "../src/timeline";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomInputs(seed: number, n = 40): TimelineSceneInput[] {
  const r = rng(seed);
  const trs: TransitionOut[] = ["cut", "fade", "fadeblack", "dissolve"];
  const beats = ["Hook", "A", "B", "C"];
  let beatIdx = 0;
  return Array.from({ length: n }, (_, i) => {
    if (i > 0 && r() < 0.15) beatIdx = Math.min(beatIdx + 1, beats.length - 1);
    return {
      beat: beats[beatIdx],
      audioSec: 3 + r() * 6,
      transitionOut: trs[Math.floor(r() * trs.length)],
    };
  });
}

const EPS = 1e-6;

describe("timeline invariants (spec 8)", () => {
  for (const seed of [1, 2, 3, 7, 42]) {
    const inputs = randomInputs(seed);
    const tl = buildTimeline(inputs);
    const fps = tl.config.fps;
    const T = tl.config.transition;

    it(`seed ${seed}: offset_k == A_{k+1} (frame-exact) for mixed fade/cut`, () => {
      for (let k = 0; k < tl.scenes.length - 1; k++) {
        // offset_k = sum_{j<=k} L_j - sum_{j<=k} T_j  (frames)
        let sumL = 0;
        let sumT = 0;
        for (let j = 0; j <= k; j++) {
          sumL += tl.scenes[j].segmentFrames;
          sumT += tl.scenes[j].fadeFrames;
        }
        expect(sumL - sumT).toBe(tl.scenes[k + 1].startFrame);
        expect(tl.scenes[k].joinOffsetFrame).toBe(tl.scenes[k + 1].startFrame);
        // within half a frame of the exact (unquantized) A_{k+1}
        const exact = tl.scenes[k + 1].startSec;
        expect(Math.abs(tl.scenes[k + 1].startFrame / fps - exact)).toBeLessThanOrEqual(0.5 / fps + EPS);
      }
    });

    it(`seed ${seed}: video length == sum D + T/2 within 1 frame`, () => {
      const sumD = tl.scenes.reduce((a, s) => a + s.slotSec, 0);
      expect(Math.abs(tl.totalSec - (sumD + T / 2))).toBeLessThan(EPS);
      expect(Math.abs(tl.totalFrames / fps - tl.totalSec)).toBeLessThanOrEqual(1 / fps);
      let sumL = 0;
      let sumT = 0;
      for (const s of tl.scenes) {
        sumL += s.segmentFrames;
        sumT += s.fadeFrames;
      }
      expect(sumL - sumT).toBe(tl.totalFrames);
    });

    it(`seed ${seed}: no fade window overlaps any speech interval`, () => {
      for (let k = 0; k < tl.scenes.length - 1; k++) {
        if (tl.scenes[k].fadeSec === 0) continue;
        const f0 = tl.scenes[k + 1].startSec;
        const f1 = f0 + T;
        for (const s of tl.scenes) {
          const overlap = Math.min(f1, s.speechEndSec) - Math.max(f0, s.speechStartSec);
          expect(overlap).toBeLessThanOrEqual(EPS);
        }
      }
    });

    it(`seed ${seed}: beat-end scenes use TAIL_BEAT`, () => {
      tl.scenes.forEach((s, i) => {
        const tail = s.isBeatEnd ? tl.config.tailBeat : tl.config.tail;
        expect(s.slotSec).toBeCloseTo(tl.config.lead + inputs[i].audioSec + tail, 9);
      });
    });
  }

  it("rejects a transition that would cover speech", () => {
    expect(() =>
      buildTimeline([{ beat: "a", audioSec: 3, transitionOut: "fade" }], { transition: 0.6 }),
    ).toThrow(/too long/);
  });

  it("speech times include the T/2 narration delay", () => {
    const tl = buildTimeline([
      { beat: "a", audioSec: 4, transitionOut: "fade" },
      { beat: "a", audioSec: 5, transitionOut: "fade" },
    ]);
    expect(tl.scenes[0].speechStartSec).toBeCloseTo(0.2 + 0.2, 9); // T/2 + LEAD
    expect(tl.scenes[0].speechEndSec).toBeCloseTo(4.4, 9);
    // D_1 = 0.2 + 4 + 0.3 -> scene 2 starts at 4.5
    expect(tl.scenes[1].startSec).toBeCloseTo(4.5, 9);
    expect(tl.scenes[1].startFrame).toBe(135);
  });

  it("chunk plans cover all scenes and chain to the same total frames", () => {
    const tl = buildTimeline(randomInputs(9, 53));
    const chunks = planChunks(tl, 12);
    expect(chunks[0].sceneStart).toBe(0);
    expect(chunks.at(-1)!.sceneEnd).toBe(53);
    let sumL = 0;
    let sumT = 0;
    chunks.forEach((c, i) => {
      sumL += c.frames;
      if (i < chunks.length - 1) sumT += c.fadeFrames;
    });
    expect(sumL - sumT).toBe(tl.totalFrames);
  });
});
