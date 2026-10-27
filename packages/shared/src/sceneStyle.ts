/**
 * Scene Style Lock: the part of every image prompt that makes backgrounds look painted by the same artist.
 * One source of truth (like characterLock.ts); bump SCENE_STYLE_VERSION after any change to the text below.
 */
export const SCENE_STYLE_VERSION = 1;

export const LIGHTINGS = ["golden_hour", "midday", "dusk", "night", "indoor_warm", "indoor_cool", "overcast"] as const;
export type Lighting = (typeof LIGHTINGS)[number];
export const DEFAULT_LIGHTING: Lighting = "golden_hour";

/** The painting rules, shared by the three ways the style sample can be attached. */
const MATCH_STYLE =
  "Match its painting style exactly: soft, simplified painted shapes with gentle gradients, very low detail, no hard outlines on the background, no textures other than a faint paper grain, the same level of simplicity and the same edge softness.";
const NEW_COMPOSITION =
  "Do not copy its composition, its objects or its sun position. Use a different horizon height and different object placement, and invent a new composition for this scene. The background must look like the same artist painted it.";

/**
 * How the style sample is attached:
 *  - "second":  a hero sheet is reference 1 and the sample is reference 2 (services that take several pictures)
 *  - "with_hero": the sample is the only picture and it shows the hero (services that take one picture per call)
 *  - "no_hero": the sample is the only picture and this scene has no person, so its hero must stay out
 */
export type AnchorKind = "second" | "with_hero" | "no_hero";

export const ANCHOR_RULES: Record<AnchorKind, string> = {
  second: `Use the second attached image as the style reference. ${MATCH_STYLE} Do not copy its characters. ${NEW_COMPOSITION}`,
  with_hero: `Use the attached image as the style reference. ${MATCH_STYLE} The character standing in it is the exact look of the main character: copy his head shape, face style, eyelids, hands, line weight and proportions, but follow the outfit, expression and pose listed below. ${NEW_COMPOSITION}`,
  no_hero: `Use the attached image as the style reference. ${MATCH_STYLE} The character standing in it only shows the line style: do not draw him, or anyone like him, in this scene. ${NEW_COMPOSITION}`,
};

// Short palette sentences keyed by the scene "lighting" value.
export const PALETTES: Record<Lighting, string> = {
  golden_hour: "Palette: soft peach and warm orange sky (#F4C7A1 to #E8A07A), ochre-brown ground (#A06E45), muted olive grass tufts (#8A8F4A), warm grey rocks (#8C857C).",
  midday: "Palette: pale warm cream sky (#F6E6C8) fading to light blue at the top (#BFD9E6), sandy ground (#C9A06B), muted olive greens (#8A9A55), warm grey rocks (#9A9288).",
  dusk: "Palette: deep warm orange horizon (#E8864F) rising into dusty violet and navy sky (#5A4A7A to #2B2E55), dark brown ground (#5C4030), tiny warm orange light accents.",
  night: "Palette: deep midnight blue sky (#1E2745) with a few tiny stars and a pale moon, dark blue-brown ground (#3A3430), a single warm orange light accent (#F29A4A).",
  indoor_warm: "Palette: warm cream walls (#EBD8B8), brown wooden furniture (#8A5E3C), a soft warm orange lamp glow (#F4B46A), muted dusty blue accents (#6F89A6).",
  indoor_cool: "Palette: light grey-blue walls (#D5DEE6), pale wooden or white surfaces (#EDEAE2), soft teal accents (#5FA3A8), a gentle warm light from one side (#F1D9B0).",
  overcast: "Palette: soft pale grey-beige sky (#D8D2C8), muted brown-grey ground (#9A8C78), muted olive greens (#8A9660), no strong shadows.",
};

export const SCENE_COMPOSITION =
  "Composition: simple and uncluttered, one clear focal point, a clear horizon or floor line, large calm areas in the upper or lower third that can hold subtitles. Background objects are few, simple and slightly softer than the characters.";

/** Close and detail shots have no landscape: the subject sits on a plain wash of the palette. */
export const DETAIL_BACKGROUND = "The background behind the subject is a plain soft out-of-focus color wash from the palette, with no landscape.";

export const SCENE_NEGATIVE =
  "Do not draw: photorealism, heavy shadows, dense detail, outlines on the background, 3D rendering, dark muddy colors, busy patterns, text, letters, numbers, logos.";
/** The same list for a picture that is allowed to carry words (labels). */
export const SCENE_NEGATIVE_WITH_LABELS =
  "Do not draw: photorealism, heavy shadows, dense detail, outlines on the background, 3D rendering, dark muddy colors, busy patterns, logos.";

export const isLighting = (v: unknown): v is Lighting => typeof v === "string" && (LIGHTINGS as readonly string[]).includes(v);
