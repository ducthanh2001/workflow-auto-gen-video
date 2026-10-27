import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import sharp from "sharp";
import { composeThumbnail, generateThumbConcepts, limitWords, contrastRatio, relLuminance, THUMB_W, THUMB_H } from "../src/thumbnail";
import { buildMetadata, fallbackDraft, generateMetadataDraft } from "../src/metadata";
import { buildChapters } from "../src/chapters";
import { buildTimeline } from "../src/timeline";
import { nextStep, planRun, canApprove } from "../src/flow";
import { MockLlm, MockTts, MockImage, mockPlan } from "../src/providers/mock";
import { fetchWithRetry, parseRetryAfter, redact, ProviderError } from "../src/providers/http";
import { planScenes } from "../src/planner";
import { parseScript } from "../src/parser";
import { makeScript } from "./fixtures";

const FONT = path.resolve(__dirname, "../../../assets/fonts/Anton-Regular.ttf");

async function bg(color: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 1600, height: 900, channels: 3, background: color } }).png().toBuffer();
}

describe("thumbnail", () => {
  it("limits text to 4 words, uppercase", () => {
    expect(limitWords("what really happens when you die tonight")).toBe("WHAT REALLY HAPPENS WHEN");
  });

  it("renders 1280x720 JPG under 2 MB with contrast >= 7:1 on a dark background", async () => {
    const r = await composeThumbnail({ background: await bg({ r: 12, g: 20, b: 50 }), text: "The last hour", fontPath: FONT });
    const meta = await sharp(r.jpg).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([THUMB_W, THUMB_H, "jpeg"]);
    expect(r.jpg.length).toBeLessThan(2 * 1024 * 1024);
    expect(r.check.contrast).toBeGreaterThanOrEqual(7);
    expect(r.check.textWidthRatio).toBeLessThanOrEqual(0.35);
    expect(r.check.badgeCornerClear).toBe(true);
    expect(r.check.smallFontPx).toBeGreaterThan(9);
    expect(r.check.warnings).toEqual([]);
    const small = await sharp(r.smallPreview).metadata();
    expect([small.width, small.height]).toEqual([168, 94]);
  });

  it("adds a scrim so a bright background still reaches 7:1", async () => {
    const r = await composeThumbnail({ background: await bg({ r: 245, g: 240, b: 220 }), text: "What happens next", fontPath: FONT });
    expect(r.check.contrast).toBeGreaterThanOrEqual(7);
  });

  it("actually draws white text pixels", async () => {
    const r = await composeThumbnail({ background: await bg({ r: 12, g: 20, b: 50 }), text: "The last hour", fontPath: FONT });
    const { data, info } = await sharp(r.jpg).raw().toBuffer({ resolveWithObject: true });
    let white = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) white++;
    expect(white).toBeGreaterThan(2000);
  });

  it("generates 3 concepts with <= 4 words each (mock LLM)", async () => {
    const { concepts } = await generateThumbConcepts(new MockLlm(), { title: "t", narrationExcerpt: "x" });
    expect(concepts).toHaveLength(3);
    for (const c of concepts) expect(c.text.split(" ").length).toBeLessThanOrEqual(4);
  });

  it("contrast helpers behave", () => {
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 5);
    expect(relLuminance(255, 255, 255)).toBeCloseTo(1, 5);
  });
});

describe("metadata", () => {
  const tl = buildTimeline(
    ["Hook", "Hook", "Mid", "Mid", "End", "End"].map((beat, i) => ({ beat, audioSec: 6 + i, transitionOut: "fade" as const })),
  );
  const { chapters } = buildChapters(tl);

  it("builds titles (first = script title), chapters, sources, disclosure and 8-12 tags", async () => {
    const { draft } = await generateMetadataDraft(new MockLlm(), { title: "My Title", narration: "n" });
    const m = buildMetadata({ title: "My Title", draft, chapters, sources: ["https://example.org/a"] });
    expect(m.titles[0]).toBe("My Title");
    expect(m.titles.length).toBe(3);
    expect(m.titles.every((t) => t.length <= 70)).toBe(true);
    expect(m.tags.length).toBeGreaterThanOrEqual(8);
    expect(m.tags.length).toBeLessThanOrEqual(12);
    expect(m.description).toMatch(/^0:00 Hook$/m);
    expect(m.description).toContain("https://example.org/a");
    expect(m.description).toContain("not medical advice");
    expect(m.description).toMatch(/synthetic/);
    expect(m.markdown).toContain("altered/synthetic content disclosure");
  });

  it("warns on missing sources, long title and few tags; falls back without an LLM", () => {
    const d = fallbackDraft("A very long title ".repeat(6), "First sentence here. Second one follows.");
    const m = buildMetadata({ title: "A very long title ".repeat(6), draft: { ...d, tags: ["a"] }, chapters, sources: [] });
    expect(m.warnings.join(" ")).toMatch(/70/);
    expect(m.warnings.join(" ")).toMatch(/tags/);
    expect(m.warnings.join(" ")).toMatch(/sources/i);
  });
});

describe("flow", () => {
  it("stops at every gate and only approves from the right state", () => {
    expect(nextStep("planned")).toEqual({ kind: "gate", gate: "plan_approved" });
    expect(nextStep("refs_ready")).toEqual({ kind: "gate", gate: "refs_approved" });
    expect(nextStep("imaged")).toEqual({ kind: "gate", gate: "images_approved" });
    expect(nextStep("draft_rendered")).toEqual({ kind: "gate", gate: "draft_approved" });
    expect(canApprove("planned", "plan_approved")).toBe(true);
    expect(canApprove("imaged", "plan_approved")).toBe(false);
  });

  it("walks the whole machine to done", () => {
    let s = "parsed" as Parameters<typeof nextStep>[0];
    const seen: string[] = [];
    for (let i = 0; i < 40 && s !== "done"; i++) {
      const step = nextStep(s);
      if (step.kind === "gate") s = step.gate;
      else if (step.kind === "stage" || step.kind === "finalize") {
        seen.push(step.kind === "stage" ? step.stage : "finalize");
        s = step.becomes;
      }
    }
    expect(s).toBe("done");
    expect(seen).toEqual(["plan", "refs", "voice", "image", "clip", "render_draft", "render_final", "thumb", "metadata", "finalize"]);
  });

  it("planRun reports reached when the target is already satisfied", () => {
    expect(planRun("voiced", "planned")).toEqual({ kind: "reached" });
    expect(planRun("parsed", "final_rendered").kind).toBe("stage");
  });
});

describe("mock providers", () => {
  it("MockTts duration tracks word count", async () => {
    const t = new MockTts();
    const a = await t.synthesize({ text: "one two three four five six seven eight nine ten", voiceId: "v", model: "m" });
    const b = await t.synthesize({ text: "one two three four five", voiceId: "v", model: "m" });
    expect(a.audio.length).toBeGreaterThan(b.audio.length * 1.7);
    expect(a.audio.subarray(0, 4).toString()).toBe("RIFF");
  });
  it("MockImage returns a PNG", async () => {
    const r = await new MockImage().generate({ prompt: "x", refs: [], aspect: "16:9" });
    expect((await sharp(r.image).metadata()).format).toBe("png");
  });
  it("MockLlm planning passes the verbatim check on a real script", async () => {
    const parsed = parseScript(makeScript());
    const r = await planScenes(parsed, new MockLlm(), { maxAiClipShare: 0.15 });
    expect(r.attempts).toBe(1);
    expect(r.scenes.length).toBeGreaterThan(5);
    expect(mockPlan("SCRIPT:\n## A\nHello there. General Kenobi.").length).toBe(1);
  });
});

describe("http retry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses Retry-After in seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("honors 429 Retry-After then succeeds", async () => {
    const sleeps: number[] = [];
    const fn = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    const res = await fetchWithRetry("https://x.test", {}, { label: "t", sleep: async (ms) => void sleeps.push(ms) });
    expect(await res.text()).toBe("ok");
    expect(sleeps).toEqual([2000]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry 400s and never leaks keys in the error", async () => {
    const fn = vi.fn().mockResolvedValue(new Response('bad key AIzaSyA1234567890abcdefghijklmnop sk-ant-abcdefghij1234', { status: 400 }));
    vi.stubGlobal("fetch", fn);
    const err = await fetchWithRetry("https://x.test?key=SECRET", {}, { label: "t", sleep: async () => undefined }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(err.message).not.toMatch(/AIza|sk-ant/);
    expect(redact("https://a.test?key=SECRET&x=1")).toBe("https://a.test?key=[redacted]&x=1");
  });
});
