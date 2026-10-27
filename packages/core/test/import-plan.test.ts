import { describe, it, expect } from "vitest";
import { parseScript } from "../src/parser";
import { buildManualPlanPrompt, importPlan, parseImportedJson, PlanError } from "../src/planner";
import { fallbackThumbConcepts } from "../src/thumbnail";
import { makeScript, sliceScenes } from "./fixtures";

const parsed = parseScript(makeScript());
const scenes = sliceScenes(parsed.beats.map((b) => ({ beat: b.title, text: b.paragraphs.join(" ") })));
const json = JSON.stringify({ scenes });

describe("manual plan (Claude desktop, no API key)", () => {
  it("the prompt has the rules, the script and the output format", () => {
    const p = buildManualPlanPrompt(parsed, 0.15);
    expect(p).toContain("EXACT slice of the script");
    expect(p).toContain("15% of scenes");
    expect(p).toContain("## Hook");
    expect(p).toContain("ONE code block");
  });

  it("accepts an object, a bare array, and JSON inside a fenced reply with chatter", () => {
    expect(importPlan(json, parsed, { maxAiClipShare: 0.15 }).scenes.length).toBe(scenes.length);
    expect(importPlan(JSON.stringify(scenes), parsed, { maxAiClipShare: 0.15 }).scenes.length).toBe(scenes.length);
    const chatty = "Here is your plan!\n```json\n" + json + "\n```\nLet me know if you want changes.";
    expect(importPlan(chatty, parsed, { maxAiClipShare: 0.15 }).scenes.length).toBe(scenes.length);
    expect(parseImportedJson("noise " + json + " trailing")).toBeTruthy();
  });

  it("fills in optional fields Claude may leave out", () => {
    const lean = scenes.map((s) => ({ beat: s.beat, narration: s.narration, visual: s.visual }));
    const r = importPlan(JSON.stringify({ scenes: lean }), parsed, { maxAiClipShare: 0 });
    expect(r.scenes[0]).toMatchObject({ shot: "medium", camera: "push_in", motion: "kenburns", onScreenText: null });
  });

  it("rejects altered narration with a diff Claude can act on", () => {
    const bad = scenes.map((s, i) => (i === 2 ? { ...s, narration: s.narration + " and some invented words" } : s));
    expect(() => importPlan(JSON.stringify({ scenes: bad }), parsed, { maxAiClipShare: 0 })).toThrow(/word for word/);
    try {
      importPlan(JSON.stringify({ scenes: bad }), parsed, { maxAiClipShare: 0 });
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).lastDiff).toMatch(/scene/);
    }
  });

  it("gives readable errors for broken JSON, wrong shape and missing fields", () => {
    expect(() => importPlan("just words", parsed, { maxAiClipShare: 0 })).toThrow(/No JSON/);
    expect(() => importPlan('{"scenes": [ {"beat": ', parsed, { maxAiClipShare: 0 })).toThrow(/cut off/);
    expect(() => importPlan('{"nope": 1}', parsed, { maxAiClipShare: 0 })).toThrow(/Expected/);
    expect(() => importPlan('{"scenes":[{"beat":"x","narration":"y"}]}', parsed, { maxAiClipShare: 0 })).toThrow(/Scene 1: visual/);
  });

  it("applies the default camera and transition to every scene, beat ends included", () => {
    const moving = scenes.map((s, i) => ({ ...s, camera: i % 2 ? "pull_out" : "push_in", transitionOut: i % 3 ? "cut" : "fade" }));
    const r = importPlan(JSON.stringify({ scenes: moving }), parsed, { maxAiClipShare: 0, defaultCamera: "static", defaultTransition: "dissolve" });
    expect(r.scenes.length).toBe(scenes.length);
    expect(r.scenes.every((s) => s.camera === "static" && s.transitionOut === "dissolve")).toBe(true);
    // without defaults the planner's own choices are kept
    const kept = importPlan(JSON.stringify({ scenes: moving }), parsed, { maxAiClipShare: 0 });
    expect(kept.scenes.some((s) => s.camera === "push_in")).toBe(true);
    expect(kept.scenes.some((s) => s.transitionOut === "fadeblack")).toBe(true);
  });

  it("still enforces the plan rules: ai_clip cap and beat-end fadeblack", () => {
    const clips = scenes.map((s) => ({ ...s, motion: "ai_clip" }));
    const r = importPlan(JSON.stringify({ scenes: clips }), parsed, { maxAiClipShare: 0 });
    expect(r.scenes.every((s) => s.motion === "kenburns")).toBe(true);
    const ends = r.scenes.filter((s, i) => r.scenes[i + 1] && r.scenes[i + 1].beat !== s.beat);
    expect(ends.every((s) => s.transitionOut === "fadeblack")).toBe(true);
  });

  it("thumbnail fallback concepts need no LLM and stay within 4 words", () => {
    const c = fallbackThumbConcepts("What Happens in the First 24 Hours After You Die?");
    expect(c).toHaveLength(3);
    expect(c.every((x) => x.text.split(" ").length <= 4)).toBe(true);
    expect(c[0].text).toBe("WHAT HAPPENS IN THE");
  });
});
