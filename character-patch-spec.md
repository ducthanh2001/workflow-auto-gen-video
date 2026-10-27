# Character System Patch (for the existing Script-to-Video Studio)

> Give this file to the AI coding agent. It changes **only the character and image-prompt part** of the existing project (spec v2). Everything else (timeline math, ffmpeg, captions, music, thumbnails, API, UI shell) stays as it is.

---

## 1. Goal

Every image the app generates must show the **same main character** (the channel's mascot) in the **same flat stick-figure explainer style**. Per scene, only the character's **hair, outfit, props, expression and pose** may change to fit the story. The head, face and line style never change.

The main character is the channel owner's own original character. It is created from an uploaded **avatar image** and then locked in a **character sheet** that is attached as a reference to every image call.

**Originality rule.** Never use another channel's characters, logos, banners or thumbnails as references or in prompts. Never put another channel's name in a prompt or config.

---

## 2. What the character looks like (the LOCK)

The following never changes between scenes:

- Plain white round head, two small black dot eyes, a tiny simple mouth, a thin neck.
- Thin black stick arms and legs, simple rounded hands.
- Thick clean black outlines, flat colors on the character, no gradients and no shading on the character.
- The same proportions and line weight as the character sheet.

What may change per scene (the VARY fields): `hair`, `outfit`, `props`, `expression`, `pose`.

The current mascot (from the avatar) has shaggy brown hair and a brown fur tunic and holds a lantern. That is only the **default outfit**; the planner may change hair and outfit whenever the story needs it (doctor's coat, medieval robe, astronaut suit, etc.).

Optional channel signature item (for example a bright orange scarf) is configured in the style file as `signature`. It is **empty by default**. If the owner wants it, the agent must add it to the character sheet first (see 4.2), then set it in the style file.

---

## 3. Files to add or change

```
config/styles/stickman-explainer.yaml        NEW (replaces warm-ink-cartoon as default)
packages/shared/src/scene.ts                 CHANGE: add characters[]
packages/core/src/planner/prompt.ts          CHANGE: add rule 9 (planner prompt)
packages/core/src/image/buildPrompt.ts       NEW
packages/core/src/image/pickRefs.ts          NEW
packages/core/src/refs/bootstrap.ts          CHANGE: hero sheet from uploaded avatar
apps/api/...                                  CHANGE: upload endpoint, scene.characters in PATCH, migration
apps/web/...                                  CHANGE: avatar upload + character fields UI
packages/core/test/...                        NEW tests (section 9)
```

Database migration (TypeORM, `synchronize` stays off): add `characters jsonb not null default '[]'` to `scene`; add `role varchar null` to `asset` (values: `hero_avatar`, `hero_sheet`, `style_anchor`).

---

## 4. Reference bootstrapping

### 4.1 Upload the avatar
`POST /projects/:id/refs/avatar` accepts one PNG or JPG up to 5 MB, validates it with `sharp` (square or any ratio, min 512 px on the short side), stores it as an `Asset` with `type: "ref"`, `role: "hero_avatar"`. The avatar may have a dark round background; it is used only as the **source** for the sheet, never as a per-scene reference.

### 4.2 Generate the character sheet
`POST /projects/:id/refs/sheet` calls the `ImageProvider` (Gemini image) with the avatar as the only reference and this prompt. Generate **4 candidates**; the user picks one in the UI (gate `refs_approved`). The picked image is saved as `role: "hero_sheet"`.

```text
Character design sheet on a plain light-grey background, flat 2D minimalist stick-figure explainer style, thick clean black outlines, flat colors. Use the attached image as the exact character reference: plain white round head, two small black dot eyes, a tiny simple mouth, thin neck, thin black stick arms and legs, simple rounded hands. Show the same character in 4 poses side by side (standing neutral, waving, thinking with a hand on chin, pointing), wearing the same hair and outfit as the reference. Same proportions and line weight in every pose. No text, no labels, no watermark.
```

If a signature item is wanted, append to the prompt: `The character also always wears {signature}.`

### 4.3 Style anchor (unchanged)
Still generate 4 style-anchor candidates (background mood: deep midnight blue, warm earth tones, warm orange light accent) and pick one. Role `style_anchor`.

---

## 5. Style file `config/styles/stickman-explainer.yaml`

```yaml
name: stickman-explainer
aspect: "16:9"

# LOCK: pasted verbatim into every prompt that contains a character
character_lock: >
  The main character has a plain white round head, two small black dot eyes,
  a tiny simple mouth, a thin neck, thin black stick arms and legs, simple
  rounded hands and thick clean black outlines. Keep this exact head shape,
  face style, proportions and line weight as in the attached character sheet.

# VARY: fields the planner fills per scene
character_vary: [hair, outfit, props, expression, pose]

# Optional signature item; empty string = none
signature: ""

prefix: >
  Flat 2D minimalist stick-figure explainer illustration. Characters are flat
  colored with no gradients and no shading. Backgrounds are simple painted
  scenes with soft shading, deep midnight blue and warm earth tones with a
  warm orange light accent, kept simpler than a full illustration.

suffix: >
  Wide cinematic composition, one clear focal point, characters large enough
  to read the expression, uncluttered foreground, no text, no letters, no
  numbers, no logo, no watermark.

camera_defaults:
  push_in:   { zoomStart: 1.00, zoomEnd: 1.10 }
  pull_out:  { zoomStart: 1.10, zoomEnd: 1.00 }
  pan_left:  { zoom: 1.08, xFrom: 0.55, xTo: 0.45 }
  pan_right: { zoom: 1.08, xFrom: 0.45, xTo: 0.55 }
  tilt_up:   { zoom: 1.08, yFrom: 0.55, yTo: 0.45 }
  tilt_down: { zoom: 1.08, yFrom: 0.45, yTo: 0.55 }

captions:
  font: "Inter"
  size: 54
  bold: true
  outline: 3
  marginV: 60
  maxCharsPerLine: 42
  maxLines: 2
```

Validate this file with zod on load; a missing `character_lock` is a startup error.

---

## 6. Scene schema (`packages/shared`)

```ts
export const SceneCharacter = z.object({
  role: z.string().min(1),              // "hero", "doctor", "villager"...
  hair: z.string().optional(),          // "short grey scribbled hair"
  outfit: z.string().optional(),        // "white lab coat"
  props: z.string().optional(),         // "holding a lantern"
  expression: z.string().optional(),    // "worried", "surprised"
  pose: z.string().optional(),          // "pointing at a clock"
});

export const SceneDraft = z.object({
  // ...existing fields (beat, narration, visual, shot, camera, motion,
  //    transitionOut, onScreenText) unchanged...
  characters: z.array(SceneCharacter).max(3).default([]),
});
```

`narration` stays immutable after planning. `characters` is editable in the UI and via `PATCH /scenes/:id`.

---

## 7. Planner prompt change

Add this as rule 9 to the existing planner prompt (the other rules, the JSON output format and the verbatim check do not change):

```text
9. For every scene that shows people, add "characters": up to 3 objects with role, hair, outfit, props, expression, pose. The main character (role "hero") keeps the same head and face in every scene; only hair, outfit, props, expression and pose may change with the story. Do not describe the head shape, the eyes, the mouth or the line style, the system adds them. Scenes with no people use "characters": []. Never put any text, numbers or logos on clothes or props.
```

Update the output example in the prompt to include `"characters"`. The verbatim check must still pass unchanged.

---

## 8. Image prompt assembly

`packages/core/src/image/buildPrompt.ts`:

```ts
export function buildImagePrompt(style: Style, scene: SceneDraftT): string {
  const people = scene.characters.map((c) =>
    [
      c.role === "hero" ? "the main character" : `a ${c.role}`,
      c.hair && `with ${c.hair}`,
      c.outfit && `wearing ${c.outfit}`,
      c.props,
      c.expression && `${c.expression} expression`,
      c.pose,
    ]
      .filter(Boolean)
      .join(", ")
  );

  return [
    style.prefix,
    scene.characters.length ? style.character_lock : "",
    scene.characters.length && style.signature
      ? `Signature item on every main character: ${style.signature}.`
      : "",
    `Scene: ${scene.visual}`,
    people.length ? `Characters: ${people.join("; ")}.` : "",
    `Framing: ${scene.shot} shot, 16:9.`,
    style.suffix,
  ]
    .filter(Boolean)
    .join("\n");
}
```

`packages/core/src/image/pickRefs.ts`:

```ts
// Gemini accepts many refs, but use at most 3 for stable results.
export function pickRefs(scene: SceneDraftT, refs: Refs, prevImage?: string): string[] {
  const hasPeople = scene.characters.length > 0;
  const list = [
    hasPeople ? refs.heroSheet : undefined,   // only when a character appears
    refs.styleAnchor,
    prevImage,                                 // previous scene image, optional
  ].filter(Boolean) as string[];
  return list.slice(0, 3);
}
```

Rules:
- Scenes without people do **not** attach the hero sheet and do **not** include `character_lock`.
- Secondary characters use the same `character_lock` but must differ visibly in hair and outfit from the hero.
- The avatar image (`hero_avatar`) is **never** attached to scene calls; only `hero_sheet` is.
- Existing safeguards stay: no text in images (OCR check, one retry), no real people, no gore.
- Retry on identity drift: if the user or an automatic check flags the character as off-model, regenerate once with this line appended: `Same face and head as the reference, do not redesign the head.` Respect `maxRetriesPerAsset`.
- `cacheKey` must include the hero-sheet asset id and the full `characters` array, so changing a scene's outfit regenerates only that scene.

---

## 9. Web UI changes

- **References panel:** add "Upload avatar" (drag and drop), then "Generate character sheet" showing 4 candidates; picking one approves `refs_approved`. Show the avatar and the chosen sheet side by side.
- **Scenes grid / scene drawer:** show the `characters` fields as editable inputs (role, hair, outfit, props, expression, pose). Saving marks the scene's image and downstream assets stale. `narration` stays read-only.
- **Bulk edit:** a "Change outfit for all scenes of beat X" action that sets `outfit` on every hero in that beat.
- Do not expose the lock text for editing in the UI; it lives in the style file.

---

## 10. Tests and acceptance

Unit tests (`packages/core`):
1. `buildImagePrompt` includes `character_lock` when `characters.length > 0` and omits it when empty.
2. The output never contains any channel or character name listed in `config/blocklist.json` (a plain JSON array of strings the owner maintains).
3. `signature` appears only when set and only with characters.
4. `pickRefs` returns at most 3 refs; never includes `hero_avatar`; omits `hero_sheet` for people-free scenes.
5. Planner output with a `characters` array of 4 entries is rejected by zod; missing `characters` defaults to `[]`.
6. The verbatim check still passes when `characters` is present.
7. `cacheKey` changes when `outfit` changes and does not change when only `camera` changes.

Integration (mock providers, no network): run the plan to image stages on a 6-scene fixture, assert the mock image provider received the expected number of refs per scene and the expected prompt fragments.

Live smoke test (real Gemini, 6 scenes): the owner checks by eye that the head, eyes and line style match across scenes while outfits change. Acceptance: at least 5 of 6 scenes are on-model without manual retries; if fewer, tune the lock text and the sheet, not the pipeline.

---

## 11. Out of scope for this patch

Timeline math, ffmpeg rendering, captions, music, thumbnails, TTS, queue/DB structure other than the two columns in section 3, and the YouTube metadata generator are **not** changed.
