import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SceneDraft, UpdateSceneDto } from "@vp/shared";
import { parseScript } from "../src/parser";
import { importPlan } from "../src/planner";
import { buildImagePrompt, labelsMatch, parseStyle, pickRefs, type StylePreset } from "../src/style";
import { makeScript, sliceScenes } from "./fixtures";

const STYLES = path.resolve(__dirname, "../../../config/styles");
const load = async (f: string) => parseStyle(await fs.readFile(path.join(STYLES, f), "utf8"));

const hero = { role: "hero", outfit: "white lab coat", props: "checking a wristwatch", expression: "calm", pose: "standing" };

describe("character patch: image prompt", () => {
  let style: StylePreset;
  const withSignature = (s: string): StylePreset => ({ ...style, signature: s });
  const base = { visual: "A quiet hospital room at night", shot: "medium" };

  it("loads the stickman style and requires a character lock", async () => {
    style = await load("stickman-explainer.yaml");
    expect(style.character_lock).toMatch(/plain white round head/);
    expect(style.character_vary).toEqual(["hair", "outfit", "props", "expression", "pose"]);
    expect(style.signature).toBe("");
    const bad = "name: x\nprefix: a\nsuffix: b\ncamera_defaults: {}\ncaptions: {}\n";
    expect(() => parseStyle(bad)).toThrow(/character_lock/);
  });

  it("loads the bright daylight style with its own sheet prompt and anchor scenes", async () => {
    const bright = await load("stickman-flat-bright.yaml");
    expect(bright.character_lock).toMatch(/shaggy messy brown hair/);
    expect(bright.anchor_scenes).toHaveLength(4);
    expect(bright.anchor_scenes!.filter((a) => !a.characters)).toHaveLength(1);
    expect(bright.character_sheet_prompt).toMatch(/4 poses/);
    // the night style has no anchor scenes of its own, so the built-in ones are used
    expect((await load("stickman-explainer.yaml")).anchor_scenes).toBeUndefined();
    const p = buildImagePrompt({ style: bright, visual: bright.anchor_scenes![0].visual, shot: "wide", characters: [{ role: "hero" }] });
    expect(p).toContain("bright, cheerful daylight look");
    expect(p).toContain("shaggy messy brown hair");
  });

  it("still loads the older preset (its `characters` text is the lock)", async () => {
    const old = await load("warm-ink-cartoon.yaml");
    expect(old.character_lock).toMatch(/attached character sheet/);
  });

  it("includes the lock when a character is present and omits it when the scene has no people", () => {
    const withPeople = buildImagePrompt({ style, ...base, characters: [hero] });
    expect(withPeople).toContain(style.character_lock.replace(/\s+/g, " ").trim());
    expect(withPeople).toContain("the main character, wearing white lab coat, checking a wristwatch, calm expression, standing");
    const empty = buildImagePrompt({ style, ...base, characters: [] });
    expect(empty).not.toContain("plain white round head");
    expect(empty).not.toContain("Characters in this scene");
  });

  it("keeps the lock for scenes planned before characters existed (null/undefined)", () => {
    expect(buildImagePrompt({ style, ...base })).toContain("plain white round head");
    expect(buildImagePrompt({ style, ...base, characters: null })).toContain("plain white round head");
  });

  it("names a secondary character by role and never describes the head", () => {
    const p = buildImagePrompt({ style, ...base, characters: [hero, { role: "nurse", hair: "a grey bun", outfit: "blue scrubs" }] });
    expect(p).toContain("a nurse, with a grey bun, wearing blue scrubs");
  });

  it("never contains a channel name from config/blocklist.json", async () => {
    const list = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../../config/blocklist.json"), "utf8")) as string[];
    expect(list.length).toBeGreaterThan(0);
    const prompt = buildImagePrompt({ style, ...base, characters: [hero] }).toLowerCase();
    const yaml = (await fs.readFile(path.join(STYLES, "stickman-explainer.yaml"), "utf8")).toLowerCase();
    for (const name of list) {
      expect(prompt).not.toContain(name.toLowerCase());
      expect(yaml).not.toContain(name.toLowerCase());
    }
  });

  it("adds the signature item only when it is set and only with characters", () => {
    expect(buildImagePrompt({ style, ...base, characters: [hero] })).not.toContain("Signature item");
    const s = withSignature("a bright orange scarf");
    expect(buildImagePrompt({ style: s, ...base, characters: [hero] })).toContain("Signature item on every main character: a bright orange scarf.");
    expect(buildImagePrompt({ style: s, ...base, characters: [] })).not.toContain("Signature item");
  });

  it("changes the prompt (so the cache key) when the outfit changes, not when only the camera does", () => {
    const a = buildImagePrompt({ style, ...base, characters: [hero] });
    const b = buildImagePrompt({ style, ...base, characters: [{ ...hero, outfit: "a medieval robe" }] });
    expect(a).not.toBe(b);
    // camera is not part of the image prompt
    expect(buildImagePrompt({ style, ...base, characters: [hero] })).toBe(a);
  });
});

describe("words inside the picture", () => {
  let style: StylePreset;
  const base = { visual: "A split picture with a clock on the left and a campfire on the right", shot: "wide" };

  it("loads the sketch style that matches the sample pictures", async () => {
    style = await load("stickman-sketch.yaml");
    expect(style.anchor_scenes).toHaveLength(4);
    expect(style.character_lock).toMatch(/hand-drawn stick figure/);
    expect(style.suffix).toMatch(/no text/);
  });

  it("keeps the picture text-free when there are no labels", () => {
    const p = buildImagePrompt({ style, ...base, characters: [], imageText: [] });
    expect(p).toMatch(/no text, no letters, no numbers/);
    expect(p).toContain("no text or letters in the image");
    expect(p).not.toContain("Text in the picture");
  });

  it("asks for the exact labels and drops the 'no text' lines when labels are given", () => {
    const p = buildImagePrompt({ style, ...base, characters: [], imageText: ["NO JOBS", "9 TO 5"] });
    expect(p).toContain('Text in the picture: show exactly these labels');
    expect(p).toContain('"NO JOBS", "9 TO 5"');
    expect(p).not.toMatch(/no text|no letters|no numbers/i);
    expect(p).toContain("the only writing allowed is the label text above");
    expect(buildImagePrompt({ style, ...base, imageText: ["NO JOBS"], strongSpelling: true })).toContain("Double-check the spelling");
  });

  it("also drops a planner's 'no letters / no numerals' from the scene text when labels are asked for", () => {
    const visual = "A round wall clock with plain tick marks, no numerals, and a calendar page, no letters";
    const withLabels = buildImagePrompt({ style, visual, shot: "detail", characters: [], imageText: ["8 HOURS"] });
    expect(withLabels).not.toMatch(/no numerals|no letters/i);
    expect(withLabels).toContain("A round wall clock with plain tick marks");
    expect(buildImagePrompt({ style, visual, shot: "detail", characters: [] })).toContain("no numerals");
  });

  it("removes the 'no text anywhere in the image' phrase of the older style cleanly", async () => {
    const old = await load("warm-ink-cartoon.yaml");
    const p = buildImagePrompt({ style: old, ...base, imageText: ["SALARY"] });
    expect(p).not.toMatch(/no text/i);
    expect(p).not.toContain("anywhere in the image");
  });

  it("checks that OCR text contains the labels, forgiving small misreads and spacing", () => {
    expect(labelsMatch(["NO JOBS"], "some words\nNO  JOBS\n").ok).toBe(true);
    expect(labelsMatch(["no jobs", "9 TO 5"], "N0 J0BS 9 TO 5").missing).toEqual(["no jobs"]); // too short to forgive 0 for O
    expect(labelsMatch(["WORK SCHEDULE"], "work schedulc").ok).toBe(true); // 13 letters: one slip allowed
    expect(labelsMatch(["SALARY"], "salaru").ok).toBe(false);
    expect(labelsMatch(["NO JOBS"], "").missing).toEqual(["NO JOBS"]);
    expect(labelsMatch([], "anything").ok).toBe(true);
  });

  it("cleans labels leniently instead of rejecting the plan", () => {
    const scene = { beat: "Hook", narration: "Hello there", visual: "A small figure on a path at dusk", shot: "wide", camera: "static", motion: "kenburns", transitionOut: "dissolve", onScreenText: null };
    expect(SceneDraft.parse(scene).imageText).toEqual([]);
    const r = SceneDraft.parse({ ...scene, imageText: ["  no   jobs ", "", "A VERY LONG LABEL THAT GOES ON AND ON AND ON", 'say "hi"', "d", "e"] });
    expect(r.imageText).toHaveLength(3);
    expect(r.imageText[0]).toBe("no jobs");
    expect(r.imageText[1].length).toBeLessThanOrEqual(24);
    expect(r.imageText.join("")).not.toContain('"');
    expect(UpdateSceneDto.safeParse({ imageText: ["NO JOBS"] }).success).toBe(true);
  });
});

describe("character patch: reference picking", () => {
  it("attaches the sheet only for scenes with people, never more than 3 refs", () => {
    const refs = { sheet: "sheet", anchor: "anchor" };
    expect(pickRefs([{ role: "hero" }], refs)).toEqual(["sheet", "anchor"]);
    expect(pickRefs([], refs)).toEqual(["anchor"]);
    expect(pickRefs(undefined, refs)).toEqual(["sheet", "anchor"]);
    expect(pickRefs([{ role: "hero" }], refs).length).toBeLessThanOrEqual(3);
    expect(pickRefs([{ role: "hero" }], { sheet: "sheet" })).toEqual(["sheet"]);
  });
});

describe("character patch: scene schema", () => {
  const scene = {
    beat: "Hook", narration: "Hello there", visual: "A small figure on a path at dusk", shot: "wide", camera: "push_in",
    motion: "kenburns", transitionOut: "fade", onScreenText: null,
  };

  it("defaults characters to [] and rejects more than 3", () => {
    expect(SceneDraft.parse(scene).characters).toEqual([]);
    const four = Array.from({ length: 4 }, (_, i) => ({ role: `r${i}` }));
    expect(SceneDraft.safeParse({ ...scene, characters: four }).success).toBe(false);
    expect(SceneDraft.safeParse({ ...scene, characters: [hero] }).success).toBe(true);
  });

  it("lets a scene edit characters but still refuses narration", () => {
    expect(UpdateSceneDto.safeParse({ characters: [hero] }).success).toBe(true);
    expect(UpdateSceneDto.safeParse({ narration: "changed" }).success).toBe(false);
  });

  it("the verbatim check still passes when characters are present", () => {
    const parsed = parseScript(makeScript());
    const scenes = sliceScenes(parsed.beats.map((b) => ({ beat: b.title, text: b.paragraphs.join(" ") })));
    expect(scenes[0].characters.length).toBe(1);
    const r = importPlan(JSON.stringify({ scenes }), parsed, { maxAiClipShare: 0 });
    expect(r.scenes.length).toBe(scenes.length);
    expect(r.scenes[0].characters[0].role).toBe("hero");
  });

  it("an imported plan without characters gets []", () => {
    const parsed = parseScript(makeScript());
    const lean = sliceScenes(parsed.beats.map((b) => ({ beat: b.title, text: b.paragraphs.join(" ") }))).map(({ characters: _c, ...s }) => s);
    const r = importPlan(JSON.stringify({ scenes: lean }), parsed, { maxAiClipShare: 0 });
    expect(r.scenes.every((s) => s.characters.length === 0)).toBe(true);
  });
});
