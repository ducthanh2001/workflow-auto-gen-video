import { describe, it, expect } from "vitest";
import { buildTimeline } from "../src/timeline";
import { buildCues, toSrt, toAss, formatSrtTime, formatAssTime, DEFAULT_CAPTION_STYLE } from "../src/captions";
import { buildChapters, formatChapterTime, chaptersToText } from "../src/chapters";
import { estimateCost, assertBudget, BudgetExceededError, type Pricing } from "../src/cost";

const narrations = [
  "At three twelve on a quiet afternoon, a heart stops beating in a small hospital room.",
  "For the person lying there, the world does not go dark all at once.",
  "Doctors use two standards to say that a person has died, and they are not the same thing, ever.",
  "The first is the end of breathing and circulation.",
  "The second is the end of all brain function, which needs careful tests.",
  "Within seconds oxygen runs out and consciousness slips away from the patient.",
];
const beats = ["Hook", "Hook", "Dead", "Dead", "Shutdown", "Shutdown"];
const tl = buildTimeline(
  narrations.map((_, i) => ({ beat: beats[i], audioSec: 4 + i * 1.5, transitionOut: i % 2 ? "cut" : "fade" })),
);

describe("captions", () => {
  const cues = buildCues(tl, narrations);

  it("has no overlapping cues and stays within [0, TOTAL]", () => {
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].end).toBeGreaterThan(cues[i].start);
      expect(cues[i].start).toBeGreaterThanOrEqual(0);
      expect(cues[i].end).toBeLessThanOrEqual(tl.totalSec + 1e-9);
      if (i) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    }
  });

  it("respects maxLines and maxCharsPerLine", () => {
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(DEFAULT_CAPTION_STYLE.maxLines);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(DEFAULT_CAPTION_STYLE.maxCharsPerLine);
    }
  });

  it("splits an over-long scene into two cues", () => {
    const long = "word ".repeat(30).trim();
    const t = buildTimeline([{ beat: "a", audioSec: 8, transitionOut: "fade" }]);
    expect(buildCues(t, [long]).length).toBeGreaterThan(1);
  });

  it("times cues to the narration audio: start = S_i", () => {
    expect(cues[0].start).toBeCloseTo(tl.scenes[0].speechStartSec, 6);
  });

  it("writes valid SRT", () => {
    const srt = toSrt(cues);
    const blocks = srt.trim().split("\n\n");
    blocks.forEach((b, i) => {
      const lines = b.split("\n");
      expect(lines[0]).toBe(String(i + 1));
      expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
    });
    expect(formatSrtTime(3661.0789)).toBe("01:01:01,079");
  });

  it("writes ASS with the preset style", () => {
    const ass = toAss(cues);
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("Style: Default,Inter,54");
    expect(ass.match(/^Dialogue:/gm)!.length).toBe(cues.length);
    expect(formatAssTime(3661.5)).toBe("1:01:01.50");
  });
});

describe("chapters", () => {
  it("uses first scene of each beat, forces first to 0:00", () => {
    const { chapters, warnings } = buildChapters(tl);
    expect(chapters.map((c) => c.title)).toEqual(["Hook", "Dead", "Shutdown"]);
    expect(chapters[0].startSec).toBe(0);
    expect(chapters[1].startSec).toBeCloseTo(tl.scenes[2].speechStartSec, 9);
    expect(warnings).toEqual([]);
    expect(chaptersToText(chapters).split("\n")[0]).toBe("0:00 Hook");
  });
  it("warns for too few chapters and formats hours", () => {
    const one = buildTimeline([{ beat: "a", audioSec: 5, transitionOut: "fade" }]);
    expect(buildChapters(one).warnings.length).toBeGreaterThan(0);
    expect(formatChapterTime(3725)).toBe("1:02:05");
    expect(formatChapterTime(65)).toBe("1:05");
  });
});

const pricing: Pricing = {
  tts: { usdPerCredit: 0.0003, creditsPerChar: { eleven_multilingual_v2: 1, eleven_flash_v2_5: 0.5 } },
  image: { usdPerImage: 0.1 },
  clip: { usdPerSecond: { "veo-3.1-lite": 0.05 } },
  llm: { usdPerPlanCall: 0.15, usdPerThumbConceptCall: 0.05 },
};

describe("cost and budget", () => {
  it("estimates a typical 10-minute video", () => {
    const e = estimateCost(pricing, {
      ttsChars: 11000, ttsModel: "eleven_multilingual_v2", scenes: 110, aiClips: 10, clipSeconds: 5, clipModel: "veo-3.1-lite",
    });
    expect(e.tts).toBeCloseTo(3.3, 4);
    expect(e.images).toBeCloseTo(11, 4);
    expect(e.clips).toBeCloseTo(2.5, 4);
    expect(e.total).toBeCloseTo(e.plan + e.refs + e.tts + e.images + e.clips + e.thumbnails, 3);
  });
  it("halves TTS cost for flash models", () => {
    const base = { ttsChars: 1000, scenes: 1, aiClips: 0, clipSeconds: 5, clipModel: "x" };
    const a = estimateCost(pricing, { ...base, ttsModel: "eleven_multilingual_v2" }).tts;
    const b = estimateCost(pricing, { ...base, ttsModel: "eleven_flash_v2_5" }).tts;
    expect(b).toBeCloseTo(a / 2, 6);
  });
  it("budget guard refuses with the numbers", () => {
    expect(() => assertBudget(10, 5, 40)).not.toThrow();
    expect(() => assertBudget(38, 5, 40)).toThrow(BudgetExceededError);
    expect(() => assertBudget(38, 5, 40)).toThrow(/\$38\.00.*\$5\.00.*\$40\.00/);
  });
});
