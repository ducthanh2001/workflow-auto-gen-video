# Character Style Lock v2 (unify the hero across all projects)

> Give this file to the AI coding agent. It REPLACES the character look in `character-patch-spec.md` (section 2, 4.2, 5, 8). Timeline, ffmpeg, captions, API and UI stay as they are.

## 1. Why the new character looked wrong

The old `character_lock` says "two small black dot eyes, a tiny simple mouth, simple rounded hands". That is exactly what the generator drew in the new character sheet: a small head, dot eyes, black fist hands. The look of videos 1 to 3 is different:

| Feature | Videos 1-3 (target) | New sheet (wrong) |
|---|---|---|
| Head | Very large, about 1/3 of the figure, slightly irregular hand-drawn circle | Small, about 1/4 |
| Outline | Thick, slightly uneven, hand-drawn | Thin, even |
| Eyes | Heavy half-closed eyelids, round pupils, bushy eyebrows | Two tiny dots |
| Mouth | Big, expressive (open black oval or curve) | Tiny |
| Hands | White mitten hands with 3-4 short outlined fingers | Black fists |
| Hair / tunic | Jagged spiky brown hair, ragged fur tunic with jagged hem and small white collar | Smooth hair, smooth tunic |
| Background | Soft warm painted gradient sky, plain ground, a few grass tufts and grey rocks | Dark, heavier scenes |

## 2. Single source of truth (all projects)

Do this once, so every project uses the same hero:

1. Create `packages/shared/src/characterLock.ts` (section 3) and import it from every style file loader. Do not copy the text into per-project YAML.
2. Store the approved hero sheet as a **global** asset: `assets/global/hero_sheet.png` (committed or kept in object storage), with `role: "hero_sheet_global"`.
3. In `refs/bootstrap.ts`: when a project is created, **copy the global hero sheet** as its `hero_sheet`. Do not generate a new sheet per project. "Regenerate" and "Upload my own character sheet" stay in the UI, but they must show a warning: "This changes the hero for this project only."
4. Keep per-project style anchors (backgrounds can differ), but the character comes only from the global sheet.
5. Save `character_lock_version` (an integer in `characterLock.ts`) on every project and every image row. Bump it whenever the lock text or the global sheet changes, so old and new images can be told apart.
6. Always pass the hero sheet as reference **number 1** on every image call that has a character.

## 3. Code: `packages/shared/src/characterLock.ts`

```ts
export const CHARACTER_LOCK_VERSION = 2;

// Pasted verbatim into every prompt that contains the main character.
export const HERO_LOCK = `
The main character is a hand-drawn stick-figure cartoon person.
Use the attached character sheet as the exact reference for head, face, hands and line style.
Head: a very large plain white round head, about one third of the total figure height, a slightly irregular hand-drawn circle, drawn with a thick black outline of uneven weight. No visible neck.
Face: two eyes with heavy half-closed eyelids and small dark round pupils, bushy curved eyebrows, a large flexible mouth drawn as a black open shape or a simple curve. The eyebrows, eyelids and mouth change with the emotion.
Body: thin black stick arms and legs with slight natural curves, a loose torso garment drawn as one flat color shape with a ragged jagged hem.
Hands: white mitten-like hands with three or four short fingers outlined in black. Feet: small black rounded shoes.
Hair: jagged, spiky, hand-drawn strands drawn over the top of the head.
Colors: flat colors on the character with at most a faint paper texture. No gradients, no shading, no highlights, no 3D.
`.trim();

// Pasted for any animal (dog, cat, ant, rat, mouse...).
export const ANIMAL_LOCK = `
Animals are drawn in the same hand-drawn cartoon style as the main character: thick uneven black outline, flat colors with no shading, a rounded simplified body, large expressive eyes with heavy half-closed eyelids and small dark pupils, simple mitten-like paws without detailed fingers or claws. Keep the same line weight and level of simplicity as the main character.
`.trim();

export const STYLE_PREFIX = `
Flat 2D hand-drawn stick-figure explainer illustration in the style of a modern webcomic. Characters are flat colored with a thick uneven black outline and no shading. Backgrounds are simple, softly painted scenes with a gentle warm gradient sky, plain ground, a few small details such as grass tufts and grey rocks, kept much simpler than the character focus.
`.trim();

export const STYLE_SUFFIX = `
Wide cinematic 16:9 composition, one clear focal point, characters large enough to read the expression, uncluttered foreground, no text, no letters, no numbers, no logo, no watermark.
`.trim();

// Always appended to image prompts that contain a character.
export const NEGATIVE = `
Do not draw: tiny dot eyes, a small head, black fist hands, a thin or perfectly even outline, a perfectly geometric circle head, shading, highlights, gradients on the character, 3D rendering, realistic proportions, anime style, text, logos.
`.trim();

// Maps the free-text `expression` of a scene to face instructions. Fallback: use the text as is.
export const EXPRESSIONS: Record<string, string> = {
  calm: "relaxed half-closed eyelids, level eyebrows, small gentle smile",
  tired: "very heavy drooping eyelids, flat tilted eyebrows, mouth a small down curve",
  exhausted: "very heavy drooping eyelids with dark bags, eyebrows sagging, mouth open slightly",
  surprised: "wide open round eyes with tiny pupils, high raised eyebrows, large open oval mouth",
  shocked: "wide open round eyes with tiny pupils, high raised eyebrows, large open oval mouth",
  worried: "eyebrows tilted up in the middle, eyes looking sideways, wavy mouth",
  stressed: "wide eyes, eyebrows tilted up in the middle, tight grimace, small sweat drops",
  curious: "one raised eyebrow, eyes looking up and aside, small open mouth",
  puzzled: "one raised eyebrow, eyes looking up and aside, small crooked mouth",
  happy: "wide curved eyelids, raised eyebrows, big smile",
  proud: "half-closed eyelids looking down, raised chin, wide smile",
  focused: "narrowed eyes, straight eyebrows, small closed mouth",
  angry: "eyebrows slanted sharply down toward the nose, narrow eyes, mouth a wide frown",
  sad: "eyebrows tilted up in the middle, droopy eyelids, mouth a down curve",
  sleepy: "eyelids almost closed, relaxed eyebrows, mouth a small open oval",
  doubtful: "one eyebrow raised, flat half-closed eyes, lopsided mouth",
};

export const DEFAULT_OUTFITS = {
  ancient: { hair: "shaggy jagged brown hair", outfit: "ragged brown fur tunic with a jagged hem and a small white fur collar" },
  modern:  { hair: "short messy spiky brown hair", outfit: "plain blue t-shirt" },
};
```

## 4. Change `buildPrompt.ts`

```ts
import { HERO_LOCK, ANIMAL_LOCK, STYLE_PREFIX, STYLE_SUFFIX, NEGATIVE, EXPRESSIONS } from "@shared/characterLock";

const ANIMALS = ["dog", "cat", "ant", "rat", "mouse", "bird", "horse", "cow", "sheep", "pig"];
const isAnimal = (role: string) => ANIMALS.some((a) => role.toLowerCase().includes(a));

export function buildImagePrompt(scene: SceneDraftT): string {
  const hasHero = scene.characters.some((c) => c.role === "hero");
  const hasOthers = scene.characters.some((c) => c.role !== "hero" && !isAnimal(c.role));
  const hasAnimals = scene.characters.some((c) => isAnimal(c.role));

  const people = scene.characters.map((c) =>
    [
      c.role === "hero" ? "the main character" : `a ${c.role}`,
      c.hair && `with ${c.hair}`,
      c.outfit && `wearing ${c.outfit}`,
      c.props,
      c.expression && `face: ${EXPRESSIONS[c.expression.toLowerCase()] ?? c.expression}`,
      c.pose,
    ].filter(Boolean).join(", ")
  );

  return [
    STYLE_PREFIX,
    hasHero ? HERO_LOCK : "",
    hasOthers ? "Other people use the same drawing style as the main character: large white round head, heavy eyelids, expressive mouth, white mitten hands, thick uneven outline, flat colors. Only their hair and clothes differ." : "",
    hasAnimals ? ANIMAL_LOCK : "",
    `Scene: ${scene.visual}`,
    people.length ? `Characters: ${people.join("; ")}.` : "",
    `Framing: ${scene.shot} shot, 16:9.`,
    STYLE_SUFFIX,
    scene.characters.length ? NEGATIVE : "",
  ].filter(Boolean).join("\n");
}
```

Reference order (`pickRefs.ts`): 1) global hero sheet (only when a character appears), 2) style anchor, 3) previous scene image (optional). Never pass a different channel's art.

## 5. Gemini prompt for the new hero sheet (generate once, then lock)

Use a clean frame of the hero from a published video (the second image you sent, with the caption cropped out) as the only reference, with this prompt. Generate 4 candidates, pick the best one, and save it as the **global** hero sheet.

```text
Character model sheet on a plain light grey background, flat 2D hand-drawn stick-figure cartoon style, thick black outline of uneven weight, flat colors, no shading, no gradients. Use the attached image as the exact reference for the character: a very large plain white round head (about one third of the figure height, slightly irregular hand-drawn circle), heavy half-closed eyelids with small dark pupils, bushy curved eyebrows, a large flexible mouth, no neck, thin black stick arms and legs, white mitten hands with three or four short outlined fingers, small black rounded shoes, jagged shaggy brown hair, a ragged brown fur tunic with a jagged hem and a small white fur collar. Top row: the full-body character in 4 poses (standing neutral, waving, thinking with a hand on the chin, pointing). Bottom row: 6 head close-ups of the same character with different expressions (neutral, tired, surprised, happy, worried, angry). Same head size, line weight and proportions in every drawing. No text, no labels, no watermark.
```

Then add a second sheet for the modern outfit in the same way (same prompt, but "short messy spiky brown hair, plain blue t-shirt"), saved as `hero_sheet_modern`. Pass it instead of the ancient sheet when the scene `outfit` is modern (rule: if `outfit` contains "shirt", "hoodie", "jacket" or "suit" use the modern sheet).

## 6. Acceptance test (run before using it for real videos)

Generate these 8 scenes with the new prompts and compare them with the second reference image:

1. Hero, ancient outfit, tired, standing, waving (close-up, like the reference).
2. Hero, modern outfit, stressed at a desk (medium).
3. Hero, surprised, pointing at a chalkboard (medium).
4. Hero with a dog on a sofa (medium).
5. A researcher with a lab coat (other person style check).
6. A dog sniffing a jar (animal style check).
7. A cat curled on a bed (animal style check).
8. Wide shot of three small figures walking across a field (small head check).

A pass needs, in every image: a big irregular white head, heavy half-closed eyelids, white mitten hands with fingers, thick uneven outline, flat colors. If the hands or eyes come out wrong in more than 2 of 8, make the character sheet reference larger in the call (crop it to the head and upper body) and re-test before bumping `CHARACTER_LOCK_VERSION`.
