import { describe, it, expect } from "vitest";
import { parseScript, ScriptError, normalizeText } from "../src/parser";
import { verbatimCheck } from "../src/verbatim";
import { planScenes, PlanError, extractJson, enforcePlanRules, type LlmClient } from "../src/planner";
import { checkVisualPrompt } from "../src/safety";
import { makeScript, sliceScenes } from "./fixtures";

describe("parser", () => {
  it("parses front matter and beats; headings are not narrated", () => {
    const p = parseScript(makeScript());
    expect(p.meta.title).toMatch(/First 24 Hours/);
    expect(p.beats.map((b) => b.title)).toEqual(["Hook", 'What "dead" means', "The slow shutdown"]);
    expect(p.narration).not.toMatch(/Hook/);
    expect(p.wordCount).toBeGreaterThanOrEqual(100);
    expect(p.warnings).toEqual([]);
  });

  it("warns on empty sources", () => {
    const p = parseScript(makeScript({ sources: false }));
    expect(p.warnings.some((w) => /sources/i.test(w))).toBe(true);
  });

  it("rejects short scripts, big files, missing title and non-English", () => {
    expect(() => parseScript("---\ntitle: x\n---\n## A\nToo short.")).toThrow(ScriptError);
    expect(() => parseScript("x".repeat(200 * 1024 + 1))).toThrow(/larger/);
    expect(() => parseScript("---\nlanguage: en\n---\n## A\n" + "word ".repeat(120))).toThrow(/title/);
    expect(() => parseScript("---\ntitle: t\nlanguage: vi\n---\n## A\n" + "word ".repeat(120))).toThrow(/English/);
  });

  it("normalizes quotes and whitespace", () => {
    expect(normalizeText("It’s  “fine” ok")).toBe("It's \"fine\" ok");
  });

  it("puts text before the first heading into an Intro beat", () => {
    const p = parseScript("---\ntitle: t\n---\n" + "alpha ".repeat(60) + "\n\n## B\n" + "beta ".repeat(60));
    expect(p.beats.map((b) => b.title)).toEqual(["Intro", "B"]);
  });
});

describe("verbatim check", () => {
  const script = "Hello, world! This is   a test.";
  it("ignores case, punctuation and whitespace", () => {
    expect(verbatimCheck(script, ["hello world", "THIS is a test"]).ok).toBe(true);
  });
  it("catches a changed word and reports where", () => {
    const r = verbatimCheck(script, ["Hello world", "This was a test"]);
    expect(r.ok).toBe(false);
    expect(r.diff).toMatch(/scene 2/);
  });
  it("catches dropped and added words", () => {
    expect(verbatimCheck(script, ["Hello world This is a"]).ok).toBe(false);
    expect(verbatimCheck(script, ["Hello world This is a test again"]).ok).toBe(false);
  });
});

function fakeLlm(responses: string[]): LlmClient & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    async complete({ user }) {
      calls.push(user);
      return { text: responses[Math.min(i++, responses.length - 1)], costUsd: 0.1 };
    },
  };
}

describe("planner", () => {
  const parsed = parseScript(makeScript());
  const byBeat = parsed.beats.map((b) => ({ beat: b.title, text: b.paragraphs.join(" ") }));
  const good = JSON.stringify({ scenes: sliceScenes(byBeat) });

  it("accepts a verbatim plan on the first try", async () => {
    const llm = fakeLlm([good]);
    const r = await planScenes(parsed, llm, { maxAiClipShare: 0.15 });
    expect(r.attempts).toBe(1);
    expect(r.scenes.length).toBeGreaterThan(5);
    expect(r.costUsd).toBeCloseTo(0.1);
  });

  it("retries with the diff when the LLM alters a word, then succeeds", async () => {
    const bad = sliceScenes(byBeat);
    bad[2].narration = bad[2].narration.replace(/\b(\w+)\b/, "ALTERED");
    const llm = fakeLlm([JSON.stringify({ scenes: bad }), good]);
    const r = await planScenes(parsed, llm, { maxAiClipShare: 0.15 });
    expect(r.attempts).toBe(2);
    expect(llm.calls[1]).toMatch(/did NOT reproduce the script exactly/);
  });

  it("fails with a clear error after 2 retries", async () => {
    const bad = sliceScenes(byBeat);
    bad[0].narration += " extra invented words";
    const llm = fakeLlm([JSON.stringify({ scenes: bad })]);
    await expect(planScenes(parsed, llm, { maxAiClipShare: 0.15 })).rejects.toThrow(PlanError);
    expect(llm.calls.length).toBe(3);
  });

  it("handles code-fenced JSON and rejects schema violations", async () => {
    expect(extractJson("here\n```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    const llm = fakeLlm([JSON.stringify({ scenes: [{ beat: "x" }] })]);
    await expect(planScenes(parsed, llm, { maxAiClipShare: 0.15, maxVerbatimRetries: 0 })).rejects.toThrow(/invalid/);
  });

  it("caps ai_clip share and fades to black at beat ends", () => {
    const scenes = sliceScenes(byBeat).map((s) => ({ ...s, motion: "ai_clip" as const }));
    const { scenes: out } = enforcePlanRules(scenes, { maxAiClipShare: 0.15 });
    const clips = out.filter((s) => s.motion === "ai_clip").length;
    expect(clips).toBe(Math.floor(scenes.length * 0.15));
    const beatEnds = out.filter((s, i) => out[i + 1] && out[i + 1].beat !== s.beat);
    expect(beatEnds.every((s) => s.transitionOut === "fadeblack")).toBe(true);
    expect(enforcePlanRules(scenes, { maxAiClipShare: 0 }).scenes.every((s) => s.motion === "kenburns")).toBe(true);
  });
});

describe("safety filter", () => {
  it("blocks graphic and self-harm prompts, passes symbolic ones", () => {
    expect(checkVisualPrompt("A bloody corpse on the floor").ok).toBe(false);
    expect(checkVisualPrompt("A figure with a noose").ok).toBe(false);
    expect(checkVisualPrompt("A candle burning low beside a stopped clock").ok).toBe(true);
  });
});
