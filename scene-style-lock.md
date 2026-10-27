# Scene Style Lock (backgrounds consistent with the style sample)

> Give this file to the AI coding agent. It adds to `character-style-lock-v2.md`: it changes only how the **scene and background** part of every image prompt is built. Hero, animals, timeline and ffmpeg stay as they are.

## 1. Idea

1. Generate the style sample once (Prompt 3 from the chat) and approve it. It is saved as the project's `style_anchor` (the global default anchor is stored once and copied into each new project, like the hero sheet).
2. Every scene image is generated with the anchor as reference number 2. The prompt tells Gemini to copy the **painting style, palette, level of detail and edge treatment** of the anchor, and to **invent a new composition** for the scene.
3. Each scene gets a `lighting` value (a short enum). The code maps it to a fixed palette sentence, so a night scene and a day scene still look like the same artist drew them.

## 2. Schema change (`packages/shared/src/scene.ts`)

```ts
export const Lighting = z.enum([
  "golden_hour", "midday", "dusk", "night", "indoor_warm", "indoor_cool", "overcast",
]);

export const SceneDraft = z.object({
  // ...existing fields unchanged...
  lighting: Lighting.default("golden_hour"),
});
```

Planner prompt: add rule 10.

```text
10. For every scene add "lighting": one of golden_hour, midday, dusk, night, indoor_warm, indoor_cool, overcast. Use golden_hour by default, indoor_warm for rooms and homes, indoor_cool for laboratories and offices, and keep the same lighting for consecutive scenes in one place. Never mention colors, brushwork or art style in "visual"; the system adds them.
```

Migration: `lighting varchar not null default 'golden_hour'` on `scene`.

## 3. Code: `packages/shared/src/sceneStyle.ts`

```ts
export const SCENE_STYLE_VERSION = 1;

// Always added when a style anchor exists. The anchor is attached as a reference image.
export const ANCHOR_RULE = `
Use the second attached image as the style reference. Match its painting style exactly: soft, simplified painted shapes with gentle gradients, very low detail, no hard outlines on the background, no textures other than a faint paper grain, the same level of simplicity and the same edge softness. Do not copy its composition, its objects, its sun position or its characters. Invent a new composition for this scene. The background must look like the same artist painted it.
`.trim();

// Short palette sentences keyed by the scene "lighting" value.
export const PALETTES: Record<string, string> = {
  golden_hour: "Palette: soft peach and warm orange sky (#F4C7A1 to #E8A07A), ochre-brown ground (#A06E45), muted olive grass tufts (#8A8F4A), warm grey rocks (#8C857C).",
  midday:      "Palette: pale warm cream sky (#F6E6C8) fading to light blue at the top (#BFD9E6), sandy ground (#C9A06B), muted olive greens (#8A9A55), warm grey rocks (#9A9288).",
  dusk:        "Palette: deep warm orange horizon (#E8864F) rising into dusty violet and navy sky (#5A4A7A to #2B2E55), dark brown ground (#5C4030), tiny warm orange light accents.",
  night:       "Palette: deep midnight blue sky (#1E2745) with a few tiny stars and a pale moon, dark blue-brown ground (#3A3430), a single warm orange light accent (#F29A4A).",
  indoor_warm: "Palette: warm cream walls (#EBD8B8), brown wooden furniture (#8A5E3C), a soft warm orange lamp glow (#F4B46A), muted dusty blue accents (#6F89A6).",
  indoor_cool: "Palette: light grey-blue walls (#D5DEE6), pale wooden or white surfaces (#EDEAE2), soft teal accents (#5FA3A8), a gentle warm light from one side (#F1D9B0).",
  overcast:    "Palette: soft pale grey-beige sky (#D8D2C8), muted brown-grey ground (#9A8C78), muted olive greens (#8A9660), no strong shadows.",
};

export const SCENE_COMPOSITION = `
Composition: simple and uncluttered, one clear focal point, a clear horizon or floor line, large calm areas in the upper or lower third that can hold subtitles. Background objects are few, simple and slightly softer than the characters.
`.trim();

export const SCENE_NEGATIVE = `
Do not draw: photorealism, heavy shadows, dense detail, outlines on the background, 3D rendering, dark muddy colors, busy patterns, text, letters, numbers, logos.
`.trim();
```

## 4. Change `buildPrompt.ts` (replace the earlier assembly)

```ts
import { ANCHOR_RULE, PALETTES, SCENE_COMPOSITION, SCENE_NEGATIVE } from "@shared/sceneStyle";
// plus HERO_LOCK, ANIMAL_LOCK, STYLE_PREFIX, STYLE_SUFFIX, NEGATIVE, EXPRESSIONS from characterLock

export function buildImagePrompt(scene: SceneDraftT, opts: { hasAnchor: boolean }): string {
  // ...people, hasHero, hasOthers, hasAnimals as in character-style-lock-v2...
  return [
    STYLE_PREFIX,
    opts.hasAnchor ? ANCHOR_RULE : "",
    hasHero ? HERO_LOCK : "",
    hasOthers ? OTHERS_LOCK : "",
    hasAnimals ? ANIMAL_LOCK : "",
    `Scene: ${scene.visual}`,
    people.length ? `Characters: ${people.join("; ")}.` : "",
    PALETTES[scene.lighting] ?? PALETTES.golden_hour,
    SCENE_COMPOSITION,
    `Framing: ${scene.shot} shot, 16:9.`,
    STYLE_SUFFIX,
    scene.characters.length ? NEGATIVE : "",
    SCENE_NEGATIVE,
  ].filter(Boolean).join("\n");
}
```

Reference order (`pickRefs.ts`): 1) hero sheet (only when a character appears), 2) style anchor (always), 3) previous scene image (optional, only inside the same beat and with the same lighting, to keep the place consistent). If a scene has no character, the anchor becomes reference 1. The prompt text says "second attached image", so when the hero sheet is missing, replace that phrase with "the attached image" (use two ANCHOR_RULE variants).

## 5. Shots that are not landscapes

For `detail` and `close` shots (a clipboard, a jar, a dog nose), the background is a plain soft-gradient surface in the palette color. Add to the prompt when `scene.shot` is `detail` or `close`:

```text
The background behind the subject is a plain soft out-of-focus color wash from the palette, with no landscape.
```

## 6. Acceptance test

Generate these 6 scenes with the same anchor and compare them side by side:

1. Savanna at golden hour with a small hero (like the anchor, but a new composition).
2. Modern bedroom at night, hero sitting on the bed.
3. Laboratory (indoor_cool) with a dog and a researcher.
4. Snowy city square at midday.
5. Detail shot: a tray of sample tubes on a table.
6. Hospital hallway (indoor_cool) with a cat on a bed.

Pass: the six images look painted by the same artist (same softness, same edge treatment, same level of detail, same grain), but they do not copy the anchor's composition. If the images look too different from the anchor, make the anchor sentence stronger and pass the anchor at a larger size; if they copy the anchor's composition, add "Use a different horizon height and different object placement" to `ANCHOR_RULE`. Bump `SCENE_STYLE_VERSION` after any change.
