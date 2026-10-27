/**
 * Character Style Lock v2: ONE source of truth for how the hero looks, in every project.
 * Styles that set `shared_lock: true` take their prefix, suffix, hero lock and sheet prompt from here,
 * so the text is never copied into per-project or per-style YAML. Bump CHARACTER_LOCK_VERSION whenever
 * a word in this file or the global hero sheet changes, so old and new pictures can be told apart.
 */
export const CHARACTER_LOCK_VERSION = 3;

/** Pasted verbatim into every prompt that contains the main character. */
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

/** Other people (a researcher, a villager): same drawing style, different hair and clothes. */
export const OTHERS_LOCK =
  "Other people use the same drawing style as the main character: large white round head, heavy eyelids, expressive mouth, white mitten hands, thick uneven outline, flat colors. Only their hair and clothes differ.";

/** Pasted for any animal (dog, cat, ant, rat, mouse...). */
export const ANIMAL_LOCK = `
Animals are drawn in the same hand-drawn cartoon style as the main character: thick uneven black outline, flat colors with no shading, a rounded simplified body, large expressive eyes with heavy half-closed eyelids and small dark pupils, simple mitten-like paws without detailed fingers or claws. Keep the same line weight and level of simplicity as the main character.
`.trim();

export const STYLE_PREFIX = `
Flat 2D hand-drawn stick-figure explainer illustration in the style of a modern webcomic. Characters are flat colored with a thick uneven black outline and no shading. Backgrounds are simple, softly painted scenes kept much simpler than the character focus; their colors come from the palette given below.
`.trim();

export const STYLE_SUFFIX = `
Wide cinematic 16:9 composition, one clear focal point, characters large enough to read the expression, uncluttered foreground, no text, no letters, no numbers, no logo, no watermark.
`.trim();

/** Always appended to image prompts that contain a character. */
export const NEGATIVE = `
Do not draw: tiny dot eyes, a small head, black fist hands, a thin or perfectly even outline, a perfectly geometric circle head, shading, highlights, gradients on the character, 3D rendering, realistic proportions, anime style, text, logos.
`.trim();

/** Maps the free-text `expression` of a scene to face instructions. Fallback: the text is used as is. */
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
  modern: { hair: "short messy spiky brown hair", outfit: "plain blue t-shirt" },
} as const;

const ANCIENT_LOOK = "jagged shaggy brown hair, a ragged brown fur tunic with a jagged hem and a small white fur collar";
const MODERN_LOOK = "short messy spiky brown hair, a plain blue t-shirt";

/** Prompt for the hero sheet (made once, then locked as the global sheet). `look` picks the outfit. */
export function heroSheetPrompt(look: "ancient" | "modern" = "ancient"): string {
  return `
Character model sheet on a plain light grey background, flat 2D hand-drawn stick-figure cartoon style, thick black outline of uneven weight, flat colors, no shading, no gradients. Use the attached image as the exact reference for the character: a very large plain white round head (about one third of the figure height, slightly irregular hand-drawn circle), heavy half-closed eyelids with small dark pupils, bushy curved eyebrows, a large flexible mouth, no neck, thin black stick arms and legs, white mitten hands with three or four short outlined fingers, small black rounded shoes, ${look === "modern" ? MODERN_LOOK : ANCIENT_LOOK}. Top row: the full-body character in 4 poses (standing neutral, waving, thinking with a hand on the chin, pointing). Bottom row: 6 head close-ups of the same character with different expressions (neutral, tired, surprised, happy, worried, angry). Same head size, line weight and proportions in every drawing. No text, no labels, no watermark.
`.trim();
}

const ANIMALS = ["dog", "cat", "ant", "rat", "mouse", "bird", "horse", "cow", "sheep", "pig"];
export const isAnimalRole = (role: string) => ANIMALS.some((a) => role.toLowerCase().includes(a));

/** Rule from the lock spec: an outfit with shirt, hoodie, jacket or suit means the modern hero sheet. */
export const isModernOutfit = (outfit?: string | null) => /\b(shirt|hoodie|jacket|suit)\b/i.test(outfit ?? "");

/** "tired and slouching" -> the tired face text; an exact key wins; unknown text is returned unchanged. */
export function expressionText(expression: string): string {
  const e = expression.trim().toLowerCase();
  if (EXPRESSIONS[e]) return EXPRESSIONS[e];
  const key = Object.keys(EXPRESSIONS).find((k) => new RegExp(`\\b${k}\\b`).test(e));
  return key ? EXPRESSIONS[key] : expression.trim();
}
