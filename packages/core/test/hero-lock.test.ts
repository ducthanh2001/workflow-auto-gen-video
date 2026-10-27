import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ANCHOR_RULES, ANIMAL_LOCK, CHARACTER_LOCK_VERSION, DETAIL_BACKGROUND, EXPRESSIONS, HERO_LOCK, LIGHTINGS, NEGATIVE, OTHERS_LOCK, PALETTES,
  SCENE_COMPOSITION, SCENE_NEGATIVE, SCENE_NEGATIVE_WITH_LABELS, SCENE_STYLE_VERSION, STYLE_PREFIX, STYLE_SUFFIX, expressionText, heroSheetPrompt,
  isAnimalRole, isModernOutfit,
} from "@vp/shared";
import { buildImagePrompt, heroSheetKind, parseStyle, chooseRefs, pickRefs, type StylePreset } from "../src/style";
import { PLANNER_SYSTEM } from "../src/planner";

const STYLES = path.resolve(__dirname, "../../../config/styles");
const load = async (f: string) => parseStyle(await fs.readFile(path.join(STYLES, f), "utf8"));
const hero = { role: "hero", hair: "shaggy jagged brown hair", outfit: "ragged brown fur tunic", expression: "tired", pose: "waving" };

describe("Character Style Lock v2: one source of truth", () => {
  let style: StylePreset;

  it("the hero style takes all its look text from the shared module, never from its own YAML", async () => {
    style = await load("stickman-hero.yaml");
    expect(style.shared_lock).toBe(true);
    expect(style.prefix).toBe(STYLE_PREFIX);
    expect(style.suffix).toBe(STYLE_SUFFIX);
    expect(style.character_lock).toBe(HERO_LOCK);
    expect(style.character_sheet_prompt).toBe(heroSheetPrompt("ancient"));
    const yaml = await fs.readFile(path.join(STYLES, "stickman-hero.yaml"), "utf8");
    expect(yaml).not.toMatch(/half-closed|mitten|round head/i); // the lock text is not copied into the YAML
    expect(CHARACTER_LOCK_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("a style cannot override the shared text", () => {
    const y = "name: x\nshared_lock: true\nprefix: my own\nsuffix: my own\ncharacter_lock: my own\ncamera_defaults: {push_in: {zoomStart: 1, zoomEnd: 1.1}, pull_out: {zoomStart: 1.1, zoomEnd: 1}, pan_left: {zoom: 1}, pan_right: {zoom: 1}, tilt_up: {zoom: 1}, tilt_down: {zoom: 1}}\ncaptions: {font: Inter, size: 54, bold: true, outline: 3, marginV: 60, maxCharsPerLine: 42, maxLines: 2}\n";
    const s = parseStyle(y);
    expect(s.character_lock).toBe(HERO_LOCK);
    expect(s.prefix).toBe(STYLE_PREFIX);
  });

  it("the hero lock describes the target look and none of the wrong one", () => {
    for (const w of ["very large plain white round head", "heavy half-closed eyelids", "bushy curved eyebrows", "white mitten-like hands", "uneven weight", "No visible neck"]) {
      expect(HERO_LOCK).toContain(w);
    }
    expect(HERO_LOCK).not.toMatch(/tiny simple mouth|two small black dot eyes/);
    expect(NEGATIVE).toMatch(/tiny dot eyes.*small head.*black fist hands/);
  });

  it("a hero scene: prefix, hero lock, scene, face instructions, suffix and the negative list", () => {
    const p = buildImagePrompt({ style, visual: "A dry savanna at dusk", shot: "close", characters: [hero] });
    const at = (s: string) => p.indexOf(s);
    expect(at(STYLE_PREFIX)).toBe(0);
    expect(at(HERO_LOCK)).toBeGreaterThan(at(STYLE_PREFIX));
    expect(at("Scene: A dry savanna at dusk")).toBeGreaterThan(at(HERO_LOCK));
    expect(p).toContain(`face: ${EXPRESSIONS.tired}`);
    expect(p).not.toContain("tired expression");
    expect(p).toContain("the main character, with shaggy jagged brown hair, wearing ragged brown fur tunic");
    expect(at(STYLE_SUFFIX)).toBeGreaterThan(at("Framing:"));
    expect(p).toContain(NEGATIVE);
    expect(p).not.toContain(OTHERS_LOCK);
    expect(p).not.toContain(ANIMAL_LOCK);
  });

  it("other people and animals get their own locks", () => {
    const r = buildImagePrompt({ style, visual: "A lab", shot: "medium", characters: [{ role: "researcher", outfit: "white lab coat" }] });
    expect(r).toContain(OTHERS_LOCK);
    expect(r).not.toContain(HERO_LOCK); // no hero in this picture
    expect(r).toContain("a researcher, wearing white lab coat");
    const d = buildImagePrompt({ style, visual: "A sofa", shot: "medium", characters: [hero, { role: "dog", pose: "curled up" }] });
    expect(d).toContain(HERO_LOCK);
    expect(d).toContain(ANIMAL_LOCK);
    expect(d).not.toContain(OTHERS_LOCK); // a dog is not "another person"
    const mix = buildImagePrompt({ style, visual: "A yard", shot: "wide", characters: [hero, { role: "villager" }, { role: "cat" }] });
    expect(mix).toContain(OTHERS_LOCK);
    expect(mix).toContain(ANIMAL_LOCK);
  });

  it("scenes without people carry no lock and no negative list; legacy scenes (null) keep the hero lock", () => {
    const none = buildImagePrompt({ style, visual: "A plain with one tree", shot: "wide", characters: [] });
    for (const t of [HERO_LOCK, OTHERS_LOCK, ANIMAL_LOCK, NEGATIVE]) expect(none).not.toContain(t);
    expect(buildImagePrompt({ style, visual: "x scene here", shot: "wide" })).toContain(HERO_LOCK);
  });

  it("labels in the picture do not clash with the negative list", () => {
    const p = buildImagePrompt({ style, visual: "A sign on a post", shot: "medium", characters: [hero], imageText: ["NO JOBS"] });
    expect(p).toContain('"NO JOBS"');
    expect(p).not.toMatch(/, text, logos/);
    expect(p).toContain("logos.");
    expect(p).not.toMatch(/no text|no letters/i);
  });

  it("the older styles still build exactly their own prompt (no shared lock leaks in)", async () => {
    const old = await load("warm-ink-cartoon.yaml");
    const p = buildImagePrompt({ style: old, visual: "A room", shot: "wide", characters: [hero] });
    expect(p).not.toContain(HERO_LOCK);
    expect(p).not.toContain(NEGATIVE);
    expect(p).toContain("tired expression");
  });
});

describe("hero sheets: ancient or modern, and the face vocabulary", () => {
  it("picks the modern sheet only for a hero in a shirt, hoodie, jacket or suit", () => {
    expect(heroSheetKind([{ role: "hero", outfit: "plain blue t-shirt" }])).toBe("modern");
    expect(heroSheetKind([{ role: "hero", outfit: "grey hoodie" }])).toBe("modern");
    expect(heroSheetKind([{ role: "hero", outfit: "ragged brown fur tunic" }])).toBe("ancient");
    expect(heroSheetKind([{ role: "researcher", outfit: "lab suit" }])).toBe("ancient"); // only the hero decides
    expect(heroSheetKind([])).toBe("ancient");
    expect(isModernOutfit("a pursuit of happiness")).toBe(false);
    expect(heroSheetPrompt("modern")).toContain("plain blue t-shirt");
    expect(heroSheetPrompt("ancient")).toContain("ragged brown fur tunic");
    expect(heroSheetPrompt()).toMatch(/Top row.*Bottom row/);
  });

  it("recognises animals by role", () => {
    for (const r of ["dog", "Cat", "black cat", "ant", "pig"]) expect(isAnimalRole(r)).toBe(true);
    for (const r of ["hero", "researcher", "villager"]) expect(isAnimalRole(r)).toBe(false);
  });

  it("turns an expression word into face instructions and falls back to the text itself", () => {
    expect(expressionText("calm")).toBe(EXPRESSIONS.calm);
    expect(expressionText("Tired and slouching")).toBe(EXPRESSIONS.tired);
    expect(expressionText("smug grin")).toBe("smug grin");
  });

  it("the hero sheet goes first with every scene that has a person", () => {
    expect(pickRefs([hero], { sheet: "sheet", anchor: "anchor" })).toEqual(["sheet", "anchor"]);
    expect(pickRefs([], { sheet: "sheet", anchor: "anchor" })).toEqual(["anchor"]);
  });

  it("the planner is told the face words, the default looks, and how to name animals", () => {
    expect(PLANNER_SYSTEM).toMatch(/calm, tired, exhausted/);
    expect(PLANNER_SYSTEM).toContain("ragged brown fur tunic with a jagged hem");
    expect(PLANNER_SYSTEM).toContain("plain blue t-shirt");
    expect(PLANNER_SYSTEM).toMatch(/"dog", "cat" or "ant"/);
  });
});

describe("services that take no reference pictures", () => {
  it("drops the 'attached sheet' sentences from the hero lock, keeps the rest", async () => {
    const style = await load("stickman-hero.yaml");
    const withRefs = buildImagePrompt({ style, visual: "A room with a bed", shot: "medium", characters: [hero] });
    const noRefs = buildImagePrompt({ style, visual: "A room with a bed", shot: "medium", characters: [hero], noRefs: true });
    expect(withRefs).toContain("attached character sheet");
    expect(noRefs).not.toMatch(/attached/);
    expect(noRefs).toContain("Head: a very large plain white round head");
    expect(noRefs).toContain("Hands: white mitten-like hands");
    expect(noRefs).toContain(NEGATIVE);
  });
});

describe("model sheet guard", () => {
  it("tells the model not to copy the sheet layout and how many characters to draw (shared styles only)", async () => {
    const style = await load("stickman-hero.yaml");
    const one = buildImagePrompt({ style, visual: "A savanna", shot: "medium", characters: [hero] });
    expect(one).toContain("model sheet");
    expect(one).toContain("Never copy its layout");
    expect(one).toContain("(draw exactly 1 character, no more)");
    const two = buildImagePrompt({ style, visual: "A sofa", shot: "wide", characters: [hero, { role: "dog" }] });
    expect(two).toContain("(draw exactly 2 characters, no more)");
    // a service without reference pictures has no sheet to warn about
    expect(buildImagePrompt({ style, visual: "A savanna", shot: "medium", characters: [hero], noRefs: true })).not.toContain("model sheet");
    // scenes without people mention neither
    const none = buildImagePrompt({ style, visual: "A plain", shot: "wide", characters: [] });
    expect(none).not.toContain("model sheet");
    expect(none).not.toContain("draw exactly");
    // the older styles keep their own wording
    const old = await load("warm-ink-cartoon.yaml");
    const o = buildImagePrompt({ style: old, visual: "A room", shot: "wide", characters: [hero] });
    expect(o).not.toContain("model sheet");
    expect(o).toContain("Characters in this scene: ");
  });
});

describe("which references a service gets", () => {
  const refs = { sheet: "sheet", anchor: "anchor" };
  const people = [hero];
  it("several-picture services get the sheet (people only) and the style sample", () => {
    expect(chooseRefs({}, people, refs)).toEqual({ refs: ["sheet", "anchor"], sheet: true, anchor: true });
    expect(chooseRefs({ acceptsRefs: true }, [], refs)).toEqual({ refs: ["anchor"], sheet: false, anchor: true });
  });
  it("a service without reference input gets nothing", () => {
    expect(chooseRefs({ acceptsRefs: false }, people, refs)).toEqual({ refs: [], sheet: false, anchor: false });
  });
  it("a one-picture service gets the style sample (it also shows the hero), for scenes with and without people", () => {
    const apiz = { acceptsRefs: true, maxRefs: 1 };
    expect(chooseRefs(apiz, people, refs)).toEqual({ refs: ["anchor"], sheet: false, anchor: true });
    expect(chooseRefs(apiz, [], refs)).toEqual({ refs: ["anchor"], sheet: false, anchor: true });
    // no sample yet: the sheet, but only for scenes with people
    expect(chooseRefs(apiz, people, { sheet: "sheet" })).toEqual({ refs: ["sheet"], sheet: true, anchor: false });
    expect(chooseRefs(apiz, [], { sheet: "sheet" })).toEqual({ refs: [], sheet: false, anchor: false });
  });
});

describe("Scene Style Lock: one painting style in every scene", () => {
  let style: StylePreset;
  const scene = { visual: "A wide empty plain with one tree", shot: "wide" };
  beforeAll(async () => {
    style = await load("stickman-hero.yaml");
  });

  it("adds the palette of the scene's lighting, the composition rule and the scene negative list", () => {
    const p = buildImagePrompt({ style, ...scene, characters: [], lighting: "indoor_cool" });
    expect(p).toContain(PALETTES.indoor_cool);
    expect(p).not.toContain(PALETTES.golden_hour);
    expect(p).toContain(SCENE_COMPOSITION);
    expect(p).toContain(SCENE_NEGATIVE);
    // a missing or unknown lighting means golden hour
    expect(buildImagePrompt({ style, ...scene, characters: [] })).toContain(PALETTES.golden_hour);
    expect(buildImagePrompt({ style, ...scene, characters: [], lighting: "disco" })).toContain(PALETTES.golden_hour);
  });

  it("palette and composition come after the scene and before the framing line", () => {
    const p = buildImagePrompt({ style, ...scene, characters: [], lighting: "dusk" });
    const at = (s: string) => p.indexOf(s);
    expect(at(PALETTES.dusk)).toBeGreaterThan(at("Scene: "));
    expect(at(PALETTES.dusk)).toBeLessThan(at("Framing:"));
    expect(at(SCENE_NEGATIVE)).toBeGreaterThan(at(STYLE_SUFFIX));
  });

  it("close and detail shots sit on a plain colour wash instead of a landscape", () => {
    expect(buildImagePrompt({ style, visual: "A tray of sample tubes", shot: "detail", characters: [] })).toContain(DETAIL_BACKGROUND);
    expect(buildImagePrompt({ style, visual: "A tray of sample tubes", shot: "close", characters: [] })).toContain(DETAIL_BACKGROUND);
    expect(buildImagePrompt({ style, ...scene, characters: [] })).not.toContain(DETAIL_BACKGROUND);
  });

  it("the style-sample rule follows what is attached", () => {
    const hero1 = [hero];
    const both = buildImagePrompt({ style, ...scene, characters: hero1, attached: { sheet: true, anchor: true } });
    expect(both).toContain(ANCHOR_RULES.second);
    expect(both).toContain("Never copy its layout"); // the sheet note
    const only = buildImagePrompt({ style, ...scene, characters: hero1, attached: { sheet: false, anchor: true } });
    expect(only).toContain(ANCHOR_RULES.with_hero);
    expect(only).not.toContain("model sheet");
    expect(only).not.toMatch(/attached character sheet/); // the sheet is not attached
    const noHero = buildImagePrompt({ style, ...scene, characters: [], attached: { sheet: false, anchor: true } });
    expect(noHero).toContain(ANCHOR_RULES.no_hero);
    // nothing attached (or no `attached` given): no style-sample rule at all
    expect(buildImagePrompt({ style, ...scene, characters: hero1, attached: { sheet: false, anchor: false } })).not.toMatch(/style reference/);
    expect(buildImagePrompt({ style, ...scene, characters: hero1 })).not.toMatch(/style reference/);
  });

  it("the style-sample rule never asks to copy the composition and varies the horizon", () => {
    for (const r of Object.values(ANCHOR_RULES)) {
      expect(r).toContain("Do not copy its composition");
      expect(r).toContain("different horizon height");
    }
  });

  it("a picture with labels drops the 'no text, letters, numbers' words from the scene negative list", () => {
    const p = buildImagePrompt({ style, ...scene, characters: [], imageText: ["SALARY"] });
    expect(p).toContain(SCENE_NEGATIVE_WITH_LABELS);
    expect(p).not.toContain(SCENE_NEGATIVE);
  });

  it("older styles keep their own prompt (no palette, no scene lock)", async () => {
    const old = await load("warm-ink-cartoon.yaml");
    const p = buildImagePrompt({ style: old, ...scene, characters: [], lighting: "night", attached: { sheet: true, anchor: true } });
    for (const s of [PALETTES.night, SCENE_COMPOSITION, SCENE_NEGATIVE, ANCHOR_RULES.second]) expect(p).not.toContain(s);
  });

  it("palettes exist for every lighting and the planner is told about them", () => {
    for (const l of LIGHTINGS) expect(PALETTES[l]).toMatch(/^Palette: /);
    expect(PLANNER_SYSTEM).toContain("golden_hour, midday, dusk, night, indoor_warm, indoor_cool, overcast");
    expect(SCENE_STYLE_VERSION).toBeGreaterThanOrEqual(1);
  });
});
