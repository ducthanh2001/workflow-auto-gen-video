/** Style presets (spec 7): YAML in config/styles. */
import { parse } from "yaml";
import { z } from "zod";
import {
  ANCHOR_RULES, ANIMAL_LOCK, DEFAULT_LIGHTING, DETAIL_BACKGROUND, HERO_LOCK, NEGATIVE, OTHERS_LOCK, PALETTES, SCENE_COMPOSITION, SCENE_NEGATIVE,
  SCENE_NEGATIVE_WITH_LABELS, STYLE_PREFIX, STYLE_SUFFIX, expressionText, heroSheetPrompt, isAnimalRole, isLighting, isModernOutfit,
  type AnchorKind, type SceneCharacter,
} from "@vp/shared";

const Zoom = z.object({ zoomStart: z.number(), zoomEnd: z.number() });
const Pan = z.object({
  zoom: z.number(),
  xFrom: z.number().optional(),
  xTo: z.number().optional(),
  yFrom: z.number().optional(),
  yTo: z.number().optional(),
});

/** Scene fields the planner may change per character; everything else is the LOCK. */
const DEFAULT_CHARACTER_VARY = ["hair", "outfit", "props", "expression", "pose"];

const StyleShape = z.object({
  name: z.string(),
  aspect: z.string().default("16:9"),
  /**
   * true = prefix, suffix, hero lock and sheet prompt come from packages/shared/src/characterLock.ts
   * (Character Style Lock v2); the YAML must not carry its own copy of that text.
   */
  shared_lock: z.boolean().default(false),
  prefix: z.string(),
  /** LOCK: pasted verbatim into every prompt that contains a character. Required. */
  character_lock: z.string().min(1),
  /** VARY: the fields the planner fills per scene */
  character_vary: z.array(z.string()).default(DEFAULT_CHARACTER_VARY),
  /** optional channel signature item (e.g. a scarf); "" = none */
  signature: z.string().default(""),
  /** prompt for the character sheet when the user has not uploaded one (optional) */
  character_sheet_prompt: z.string().optional(),
  /** the 4 candidate style anchors drawn at the references step; omit to use the built-in night scenes */
  anchor_scenes: z
    .array(z.object({ visual: z.string().min(10), characters: z.boolean().default(true) }))
    .min(1)
    .max(8)
    .optional(),
  suffix: z.string(),
  camera_defaults: z.object({
    push_in: Zoom,
    pull_out: Zoom,
    pan_left: Pan,
    pan_right: Pan,
    tilt_up: Pan,
    tilt_down: Pan,
  }),
  captions: z.object({
    font: z.string(),
    size: z.number(),
    bold: z.boolean(),
    outline: z.number(),
    marginV: z.number(),
    maxCharsPerLine: z.number(),
    maxLines: z.number(),
  }),
});

/** Older presets call the lock `characters`; accept it as an alias for `character_lock`. */
export const StylePreset = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && (raw as { shared_lock?: unknown }).shared_lock === true) {
    // one source of truth: the shared text wins, a style may not override it
    return {
      ...(raw as Record<string, unknown>),
      prefix: STYLE_PREFIX,
      suffix: STYLE_SUFFIX,
      character_lock: HERO_LOCK,
      character_sheet_prompt: heroSheetPrompt("ancient"),
    };
  }
  if (raw && typeof raw === "object" && !("character_lock" in raw) && "characters" in raw) {
    const { characters, ...rest } = raw as Record<string, unknown>;
    return { ...rest, character_lock: characters };
  }
  return raw;
}, StyleShape);
export type StylePreset = z.infer<typeof StyleShape>;
export type CameraDefaults = StylePreset["camera_defaults"];

export function parseStyle(yamlText: string): StylePreset {
  return StylePreset.parse(parse(yamlText));
}

/** Style presets must never carry another channel's name (spec 1, originality rule). */
const FORBIDDEN_STYLE_WORDS = [/kurzgesagt/i, /ted-?ed/i, /vox\b/i, /veritasium/i];
export function assertOriginalStyle(s: StylePreset): void {
  const blob = JSON.stringify(s);
  for (const re of FORBIDDEN_STYLE_WORDS) {
    if (re.test(blob)) throw new Error(`Style preset "${s.name}" references another channel (${re}); remove it`);
  }
}

export interface ImagePromptInput {
  style: StylePreset;
  visual: string;
  shot: string;
  strongNoText?: boolean;
  /**
   * People in the scene. `[]` = no people: the character lock is left out.
   * `undefined`/`null` (scenes planned before characters existed, thumbnails) keep the old
   * behaviour and always carry the lock.
   */
  characters?: SceneCharacter[] | null;
  /**
   * Words the picture must show (a sign, a label). When present the "no text" lines are dropped and
   * replaced by an exact-spelling instruction; `[]`/undefined keeps the picture text-free.
   */
  imageText?: string[] | null;
  /** second attempt after the first picture spelled a label wrongly */
  strongSpelling?: boolean;
  /** the image service takes no reference pictures: the prompt must not point at an "attached" sheet */
  noRefs?: boolean;
  /** light and time of day of the scene (Scene Style Lock); unknown or missing = golden hour */
  lighting?: string | null;
  /** which pictures this call really attaches; when given it replaces `noRefs` and switches the style-sample rule on */
  attached?: { sheet: boolean; anchor: boolean };
}

/** Said when a model sheet is attached: it is a reference of the look, never a layout to repeat. */
export const SHEET_NOTE =
  "The attached picture is a model sheet that shows the main character in several poses and faces. Use it only for how the character looks. Never copy its layout, never repeat the poses or the head close-ups, and never add the characters of the sheet to the scene: draw only the characters listed below.";

/** The sentences of the locks that point at an attached picture (dropped when no picture is attached). */
const ATTACHED_SENTENCES = [
  /Use the attached character sheet as the exact reference for head, face, hands and line style\.\s*/g,
  /\s*Keep this exact head shape, face style, proportions and line weight as in the attached character sheet\./g,
];
export function withoutAttachedRefs(s: string): string {
  return ATTACHED_SENTENCES.reduce((acc, re) => acc.replace(re, ""), s);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Remove "no text / no letters / no numbers" phrases (the picture is allowed its labels). */
export function withoutNoTextClauses(s: string): string {
  return squash(
    s
      .replace(/\bno text(?: anywhere in the image)?\b,?/gi, "")
      .replace(/\bno letters\b,?/gi, "")
      .replace(/\bno (?:numbers|numerals|words|writing)\b,?/gi, "")
      .replace(/\s+,/g, ",")
      .replace(/,\s*\./g, ".")
      .replace(/^[,\s]+/, ""),
  );
}

/** Lowercase letters and digits only: "NO  JOBS!" and "no jobs" compare equal. */
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Did the picture really show every label? `ocrText` is what an OCR pass read from it. A label counts
 * when its letters appear in the OCR text, allowing one wrong character per 8 for noisy reads.
 */
export function labelsMatch(labels: string[], ocrText: string): { ok: boolean; missing: string[] } {
  const hay = flat(ocrText);
  const missing = labels.filter((l) => {
    const need = flat(l);
    if (!need) return false;
    if (hay.includes(need)) return false;
    const allowed = Math.floor(need.length / 8);
    if (!allowed) return true;
    for (let i = 0; i + need.length <= hay.length; i++) {
      let bad = 0;
      for (let j = 0; j < need.length && bad <= allowed; j++) if (hay[i + j] !== need[j]) bad++;
      if (bad <= allowed) return false;
    }
    return true;
  });
  return { ok: missing.length === 0, missing };
}

/**
 * One person as a short phrase: "the main character, with ..., wearing ..., ...". Head and face are never
 * described, except that with the shared lock the `expression` word becomes concrete face instructions.
 */
export function describeCharacter(c: SceneCharacter, sharedLock = false): string {
  return [
    c.role === "hero" ? "the main character" : `a ${c.role}`,
    c.hair && `with ${c.hair}`,
    c.outfit && `wearing ${c.outfit}`,
    c.props,
    c.expression && (sharedLock ? `face: ${expressionText(c.expression)}` : `${c.expression} expression`),
    c.pose,
  ]
    .filter(Boolean)
    .join(", ");
}

/** True when the scene shows a person, so the character lock and the character sheet apply. */
export function sceneHasPeople(characters?: SceneCharacter[] | null): boolean {
  return characters == null ? true : characters.length > 0;
}

/** Which hero sheet a scene needs: the modern one when the hero wears a shirt, hoodie, jacket or suit. */
export function heroSheetKind(characters?: SceneCharacter[] | null): "ancient" | "modern" {
  return (characters ?? []).some((c) => c.role === "hero" && isModernOutfit(c.outfit)) ? "modern" : "ancient";
}

/** Image prompt template (spec 6.5, character patch 8, Character Style Lock v2). */
export function buildImagePrompt({ style, visual, shot, strongNoText, characters, imageText, strongSpelling, noRefs, lighting, attached }: ImagePromptInput): string {
  const hasPeople = sceneHasPeople(characters);
  const shared = style.shared_lock;
  const list = characters ?? [];
  const people = list.map((c) => describeCharacter(c, shared));
  const labels = (imageText ?? []).filter(Boolean);
  const quoted = labels.map((l) => `"${l}"`).join(", ");

  // Shared lock: the hero, other people and animals each get their own lock; legacy scenes (null) count as "hero".
  const hasHero = shared ? (characters == null ? true : list.some((c) => c.role === "hero")) : hasPeople;
  const hasAnimals = shared && list.some((c) => isAnimalRole(c.role));
  const hasOthers = shared && list.some((c) => c.role !== "hero" && !isAnimalRole(c.role));
  const negative = shared && hasPeople ? (labels.length ? NEGATIVE.replace(/, text, logos\./, ", logos.") : NEGATIVE) : "";
  // what is attached: the hero sheet (several drawings of the hero) and/or the style sample (a finished scene)
  const sheetOn = attached ? attached.sheet : !noRefs;
  const anchorKind: AnchorKind | null = shared && attached?.anchor ? (sheetOn ? "second" : hasHero && hasPeople ? "with_hero" : "no_hero") : null;
  const palette = PALETTES[isLighting(lighting) ? lighting : DEFAULT_LIGHTING];

  return [
    squash(labels.length ? withoutNoTextClauses(style.prefix) : style.prefix),
    // the shared hero lock keeps its line breaks (Head / Face / Body ...): it is pasted verbatim
    anchorKind ? ANCHOR_RULES[anchorKind] : "",
    hasHero ? (sheetOn ? (x: string) => x : withoutAttachedRefs)(shared ? style.character_lock.trim() : squash(style.character_lock)) : "",
    // the attached picture is a model sheet with several drawings: it must not be copied into the scene
    shared && hasPeople && sheetOn ? SHEET_NOTE : "",
    hasOthers ? OTHERS_LOCK : "",
    hasAnimals ? ANIMAL_LOCK : "",
    hasPeople && squash(style.signature) ? `Signature item on every main character: ${squash(style.signature)}.` : "",
    // a planner "no letters" inside the scene text would fight the labels, so it goes when labels are asked for
    `Scene: ${labels.length ? withoutNoTextClauses(visual) : visual.trim()}`,
    people.length ? `Characters in this scene${shared ? ` (draw exactly ${people.length} character${people.length > 1 ? "s" : ""}, no more)` : ""}: ${people.join("; ")}.` : "",
    labels.length
      ? `Text in the picture: show exactly ${labels.length === 1 ? "this one label" : "these labels"} as clean, large, hand-lettered capital letters on the sign, banner or object that fits the scene: ${quoted}. Spell every label letter by letter exactly as written, with no extra letters, and no other words, numbers or captions anywhere.${strongSpelling ? " Double-check the spelling before finishing; correct spelling matters more than anything else." : ""}`
      : "",
    shared ? palette : "",
    shared ? SCENE_COMPOSITION : "",
    shared && (shot === "detail" || shot === "close") ? DETAIL_BACKGROUND : "",
    `Framing: ${shot} shot, 16:9.`,
    squash(labels.length ? withoutNoTextClauses(style.suffix) : style.suffix),
    negative,
    shared ? (labels.length ? SCENE_NEGATIVE_WITH_LABELS : SCENE_NEGATIVE) : "",
    labels.length
      ? "Hard constraints: no watermark, no logo, no real people; the only writing allowed is the label text above."
      : strongNoText
        ? "Hard constraints: absolutely NO text, letters, numbers, signs, captions or symbols that look like writing anywhere in the image; no watermark; no real people."
        : "Hard constraints: no text or letters in the image, no watermark, no real people.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Which reference images go with a scene call (max 3; Gemini is more stable with few).
 * The character sheet only goes with scenes that show a person; the raw avatar never does.
 */
export function pickRefs<T>(characters: SceneCharacter[] | null | undefined, refs: { sheet?: T; anchor?: T }): T[] {
  return [sceneHasPeople(characters) ? refs.sheet : undefined, refs.anchor].filter((r): r is T => r !== undefined).slice(0, 3);
}

/**
 * The reference pictures one image call really sends, for what the service can take, and which kind each is.
 *  - several pictures per call: the hero sheet first (scenes with people), then the style sample
 *  - one picture per call: the style sample (a finished scene that also shows the hero, so it carries both the
 *    painting style and the character); the hero sheet only when no sample exists
 *  - no reference input: nothing
 */
export function chooseRefs<T>(
  provider: { acceptsRefs?: boolean; maxRefs?: number },
  characters: SceneCharacter[] | null | undefined,
  refs: { sheet?: T; anchor?: T },
): { refs: T[]; sheet: boolean; anchor: boolean } {
  const none = { refs: [] as T[], sheet: false, anchor: false };
  if (provider.acceptsRefs === false) return none;
  const people = sceneHasPeople(characters);
  if (provider.maxRefs === 1) {
    if (refs.anchor !== undefined) return { refs: [refs.anchor], sheet: false, anchor: true };
    if (people && refs.sheet !== undefined) return { refs: [refs.sheet], sheet: true, anchor: false };
    return none;
  }
  const sheet = people && refs.sheet !== undefined;
  const picked = pickRefs(characters, refs);
  return { refs: picked, sheet, anchor: refs.anchor !== undefined && picked.length > 0 };
}
