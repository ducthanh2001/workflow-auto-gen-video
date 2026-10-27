/** Scene planning logic (spec 6.2). Provider-independent: an LlmClient does the call. */
import { ScenePlan, type Camera, type SceneDraft, type TransitionOut } from "@vp/shared";
import type { ParsedScript } from "./parser";
import { countWords } from "./parser";
import { verbatimCheck } from "./verbatim";
import { checkVisualPrompt } from "./safety";

export interface LlmClient {
  /** Returns the model's raw text (expected to contain one JSON object). */
  complete(input: { system: string; user: string; maxTokens?: number }): Promise<{ text: string; costUsd?: number }>;
}

export interface PlanOptions {
  maxAiClipShare: number;
  maxVerbatimRetries?: number;
  minWords?: number;
  maxWords?: number;
  /** when set, every scene gets this camera whatever the planner chose (e.g. "static": no zoom, no shake) */
  defaultCamera?: Camera;
  /** when set, every scene gets this transition, beat ends included (e.g. "dissolve") */
  defaultTransition?: TransitionOut;
}

export interface PlanResult {
  scenes: SceneDraft[];
  attempts: number;
  costUsd: number;
  warnings: string[];
}

export class PlanError extends Error {
  constructor(message: string, public readonly lastDiff?: string) {
    super(message);
    this.name = "PlanError";
  }
}

export const PLANNER_SYSTEM = `You split a narration script into video scenes and describe a picture for each scene.
Reply with ONE JSON object only, no prose: {"scenes":[{...}]}.

Each scene has: beat (the exact "##" heading it sits under), narration, visual, shot (wide|medium|close|detail),
camera (push_in|pull_out|pan_left|pan_right|tilt_up|tilt_down|static), motion (kenburns|ai_clip),
transitionOut (cut|fade|fadeblack|dissolve), onScreenText (string up to 40 chars, or null),
characters (array of up to 3 objects {role, hair, outfit, props, expression, pose}, see rule 9),
imageText (array of up to 3 short strings, see rule 10), lighting (see rule 11).

Rules:
1. Scenes are 12 to 20 words (about 4 to 8 seconds spoken). Prefer sentence boundaries; split mid-sentence only when a sentence exceeds 30 words.
2. "narration" is an EXACT slice of the script. Never paraphrase, fix grammar, add, drop or reorder words. Concatenating all scenes must reproduce the script narration exactly. Heading text is never narrated.
3. "visual" is concrete, shows one clear idea, contains no text, letters, numbers or logos (words to show in the picture go in "imageText", rule 10), and no real named people.
4. Vary shot and camera. Alternate push_in and pull_out. Never use more than 3 identical shots in a row.
5. motion "ai_clip" only where movement carries meaning (fire, rain, water, clock hands) and for at most {{CLIP_SHARE}}% of scenes; otherwise "kenburns".
6. transitionOut: "fade" by default; "fadeblack" on the last scene of a beat; "cut" between two scenes that continue the same moment.
7. Sensitive topics: no gore, no graphic bodies, no depiction of self-harm or methods of death. Use symbols (clock, hands, candle, stylized figures).
8. onScreenText is null unless a very short label truly helps.
9. For every scene that shows people, add "characters": up to 3 objects with role, hair, outfit, props, expression, pose. The main character (role "hero") keeps the same head and face in every scene; only hair, outfit, props, expression and pose may change with the story. Do not describe the head shape, the eyes, the mouth or the line style, the system adds them. Scenes with no people use "characters": []. Never put any text, numbers or logos on clothes or props.
   - "expression" is ONE word from: calm, tired, exhausted, surprised, shocked, worried, stressed, curious, puzzled, happy, proud, focused, angry, sad, sleepy, doubtful (the system turns it into face drawing instructions).
   - Default look of the hero: in prehistoric or ancient scenes hair "shaggy jagged brown hair" and outfit "ragged brown fur tunic with a jagged hem and a small white fur collar"; in modern scenes hair "short messy spiky brown hair" and outfit "plain blue t-shirt" (a different modern outfit must contain shirt, hoodie, jacket or suit).
   - Other people (a researcher, a villager) get their own role and different hair and clothes. An animal is its own character with a plain role such as "dog", "cat" or "ant".
10. "imageText" lists the words the picture itself should show, so a viewer can follow the idea: a key term, a sign, a number or a label from the narration (for example "NO JOBS", "9 TO 5", "SALARY"). Use at most 3 short items (each up to 24 characters, capital words are best) and only for scenes where a label truly helps, roughly one scene in five. Otherwise "imageText": []. Use only words that appear in or directly name the narration, never invent claims, brands or logos.
11. For every scene add "lighting": one of golden_hour, midday, dusk, night, indoor_warm, indoor_cool, overcast. Use golden_hour by default, indoor_warm for rooms and homes, indoor_cool for laboratories, hospitals and offices, midday for bright daytime outdoors, and keep the same lighting for consecutive scenes in one place. Never mention colors, brushwork or art style in "visual"; the system adds them.
Example scene: {"beat":"Hook","narration":"...","visual":"A quiet hospital room at night, a clock on the wall","shot":"medium","camera":"push_in","motion":"kenburns","transitionOut":"fade","onScreenText":null,"characters":[{"role":"hero","outfit":"white lab coat","props":"checking a wristwatch","expression":"calm","pose":"standing beside the bed"}],"imageText":[],"lighting":"indoor_cool"}`;

export function buildPlannerUser(parsed: ParsedScript, retryDiff?: string): string {
  const body = parsed.beats
    .map((b) => `## ${b.title}\n${b.paragraphs.join("\n\n")}`)
    .join("\n\n");
  let out = `Title: ${parsed.meta.title}\n\nSCRIPT:\n${body}`;
  if (retryDiff) {
    out += `\n\nYour previous answer did NOT reproduce the script exactly. ${retryDiff}\nFix this: every word of the script must appear once, in order, unchanged.`;
  }
  return out;
}

/** Extract the first top-level JSON object from model text (handles code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Enforce the rules that are cheaper and more reliable in code than in the
 * prompt: ai_clip cap, beat-end fades, last-scene transition, safety.
 */
export function enforcePlanRules(
  scenes: SceneDraft[],
  opts: Pick<PlanOptions, "maxAiClipShare" | "minWords" | "maxWords" | "defaultCamera" | "defaultTransition">,
): { scenes: SceneDraft[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = scenes.map((s) => ({ ...s }));
  const n = out.length;

  // ai_clip cap
  const cap = Math.floor(n * opts.maxAiClipShare);
  let used = 0;
  out.forEach((s, i) => {
    if (s.motion !== "ai_clip") return;
    if (used < cap) used++;
    else {
      s.motion = "kenburns";
      warnings.push(`Scene ${i + 1}: ai_clip over the ${Math.round(opts.maxAiClipShare * 100)}% cap, using kenburns`);
    }
  });

  // beat boundaries and transitions
  out.forEach((s, i) => {
    const next = out[i + 1];
    const beatEnd = !next || next.beat !== s.beat;
    if (beatEnd && i < n - 1) s.transitionOut = "fadeblack";
    if (i === n - 1) s.transitionOut = "fade"; // unused by the timeline, kept valid
    // channel look: the same transition everywhere and, with "static", no zoom or pan (nothing to shake)
    if (opts.defaultTransition) s.transitionOut = opts.defaultTransition;
    if (opts.defaultCamera) s.camera = opts.defaultCamera;
  });

  // word-count and safety warnings
  const lo = opts.minWords ?? 8;
  const hi = opts.maxWords ?? 34;
  out.forEach((s, i) => {
    const w = countWords(s.narration);
    if (w < lo || w > hi) warnings.push(`Scene ${i + 1}: ${w} words (target 12-20)`);
    const safety = checkVisualPrompt([s.visual, ...(s.characters ?? []).flatMap((c) => [c.hair, c.outfit, c.props, c.expression, c.pose])].filter(Boolean).join(" "));
    if (!safety.ok) warnings.push(`Scene ${i + 1}: visual blocked (${safety.reasons.join(", ")})`);
  });
  return { scenes: out, warnings };
}

export async function planScenes(
  parsed: ParsedScript,
  llm: LlmClient,
  opts: PlanOptions,
): Promise<PlanResult> {
  const maxRetries = opts.maxVerbatimRetries ?? 2;
  const system = PLANNER_SYSTEM.replace("{{CLIP_SHARE}}", String(Math.round(opts.maxAiClipShare * 100)));
  let retryDiff: string | undefined;
  let cost = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const res = await llm.complete({ system, user: buildPlannerUser(parsed, retryDiff), maxTokens: 32000 });
    cost += res.costUsd ?? 0;

    let plan: ScenePlan;
    try {
      plan = ScenePlan.parse(extractJson(res.text));
    } catch (e) {
      retryDiff = `The output was not valid against the schema: ${(e as Error).message.slice(0, 400)}`;
      if (attempt > maxRetries) throw new PlanError(`Planner output invalid after ${attempt} attempts: ${retryDiff}`);
      continue;
    }

    const check = verbatimCheck(parsed.narration, plan.scenes.map((s) => s.narration));
    if (!check.ok) {
      retryDiff = check.diff;
      if (attempt > maxRetries) {
        throw new PlanError(`Verbatim check failed after ${attempt} attempts. ${check.diff}`, check.diff);
      }
      continue;
    }

    const enforced = enforcePlanRules(plan.scenes, opts);
    return { scenes: enforced.scenes, attempts: attempt, costUsd: cost, warnings: enforced.warnings };
  }
  throw new PlanError("unreachable");
}

// ------------------------------------------------------------------ manual planning (no API key)

/** The same instructions the API planner uses, as one text a person can paste into any Claude chat. */
export function buildManualPlanPrompt(parsed: ParsedScript, maxAiClipShare: number): string {
  const system = PLANNER_SYSTEM.replace("{{CLIP_SHARE}}", String(Math.round(maxAiClipShare * 100)));
  return [
    system,
    "",
    "Output format: reply with the JSON only, inside ONE code block (```json ... ```), nothing before or after it.",
    "If the answer is too long for one message, put the JSON in a file or artifact instead of cutting it short.",
    "Before you answer, check that joining all \"narration\" values in order gives exactly the script text below (heading lines are not narration).",
    "",
    buildPlannerUser(parsed),
  ].join("\n");
}

/** Parse pasted text: an object {"scenes": [...]} or a bare array, optionally inside code fences. */
export function parseImportedJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to a lenient scan */
  }
  const o = candidate.indexOf("{");
  const a = candidate.indexOf("[");
  const useArray = a >= 0 && (o < 0 || a < o);
  const start = useArray ? a : o;
  const end = candidate.lastIndexOf(useArray ? "]" : "}");
  if (start < 0) throw new PlanError("No JSON found. Paste the JSON that Claude produced.");
  if (end <= start) {
    throw new PlanError("The JSON looks cut off (it never closes). Ask Claude to continue or to put the whole JSON in a file, then paste all of it.");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new PlanError(`The JSON is not valid (${(e as Error).message}). If the reply was cut off, ask Claude to continue or to put it in a file.`);
  }
}

/**
 * Validate a hand-made plan with the same gates as the API planner: schema, the verbatim check
 * against the script, and the plan rules. Missing optional fields get safe defaults.
 */
export function importPlan(
  text: string,
  parsed: ParsedScript,
  opts: Pick<PlanOptions, "maxAiClipShare" | "defaultCamera" | "defaultTransition">,
): { scenes: SceneDraft[]; warnings: string[] } {
  const raw = parseImportedJson(text);
  const list = Array.isArray(raw) ? raw : (raw as { scenes?: unknown })?.scenes;
  if (!Array.isArray(list)) throw new PlanError('Expected {"scenes": [...]} or an array of scenes.');
  const withDefaults = list.map((s) => ({
    shot: "medium",
    camera: "push_in",
    motion: "kenburns",
    transitionOut: "fade",
    onScreenText: null,
    ...(s as object),
  }));
  const parsedPlan = ScenePlan.safeParse({ scenes: withDefaults });
  if (!parsedPlan.success) {
    const i = parsedPlan.error.issues[0];
    throw new PlanError(`Scene ${typeof i.path[1] === "number" ? i.path[1] + 1 : "?"}: ${i.path.slice(2).join(".") || "scene"} ${i.message}`);
  }
  const check = verbatimCheck(parsed.narration, parsedPlan.data.scenes.map((s) => s.narration));
  if (!check.ok) {
    throw new PlanError(`The narration in the plan does not match your script word for word. ${check.diff}`, check.diff);
  }
  return enforcePlanRules(parsedPlan.data.scenes, opts);
}
