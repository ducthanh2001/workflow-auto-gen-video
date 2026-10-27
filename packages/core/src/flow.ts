/**
 * Project state machine (spec 5). Pure functions: the server decides what to
 * enqueue from `nextStep`, and stops at every approval gate.
 */
import { PROJECT_STATES, type Gate, type ProjectState, type Stage } from "@vp/shared";

export type Step =
  | { kind: "stage"; stage: Stage; becomes: ProjectState }
  | { kind: "gate"; gate: Gate }
  | { kind: "finalize"; becomes: ProjectState }
  | { kind: "done" };

const NEXT: Record<ProjectState, Step> = {
  created: { kind: "stage", stage: "plan", becomes: "planned" }, // parse happens on creation (-> parsed)
  parsed: { kind: "stage", stage: "plan", becomes: "planned" },
  planned: { kind: "gate", gate: "plan_approved" },
  plan_approved: { kind: "stage", stage: "refs", becomes: "refs_ready" },
  refs_ready: { kind: "gate", gate: "refs_approved" },
  refs_approved: { kind: "stage", stage: "voice", becomes: "voiced" },
  voiced: { kind: "stage", stage: "image", becomes: "imaged" },
  imaged: { kind: "gate", gate: "images_approved" },
  images_approved: { kind: "stage", stage: "clip", becomes: "motion_done" },
  motion_done: { kind: "stage", stage: "render_draft", becomes: "draft_rendered" },
  draft_rendered: { kind: "gate", gate: "draft_approved" },
  draft_approved: { kind: "stage", stage: "render_final", becomes: "final_rendered" },
  final_rendered: { kind: "stage", stage: "thumb", becomes: "thumbnails_ready" },
  thumbnails_ready: { kind: "stage", stage: "metadata", becomes: "metadata_ready" },
  metadata_ready: { kind: "finalize", becomes: "done" },
  done: { kind: "done" },
};

export function nextStep(state: ProjectState): Step {
  return NEXT[state];
}

export const stateIndex = (s: ProjectState) => PROJECT_STATES.indexOf(s);

/** Which state an approval of `gate` moves the project to (only valid from the matching waiting state). */
const GATE_FROM: Record<Gate, ProjectState> = {
  plan_approved: "planned",
  refs_approved: "refs_ready",
  images_approved: "imaged",
  draft_approved: "draft_rendered",
};

export function canApprove(state: ProjectState, gate: Gate): boolean {
  return state === GATE_FROM[gate];
}

/** Next action for `run {to}`: advance until `to` is reached, stopping at gates. */
export function planRun(state: ProjectState, to: ProjectState): Step | { kind: "reached" } {
  if (stateIndex(state) >= stateIndex(to)) return { kind: "reached" };
  return nextStep(state);
}

/**
 * State after regenerating an asset of `stage` for a single scene: later work is stale
 * but the project does not move backwards; the UI shows stale badges (spec 5).
 */
export const STALE_AFTER: Record<"audio" | "image" | "clip" | "visual", Array<"segment" | "chunk" | "video" | "music_mix">> = {
  audio: ["segment", "chunk", "video", "music_mix"],
  image: ["segment", "chunk", "video"],
  clip: ["segment", "chunk", "video"],
  visual: ["segment", "chunk", "video"],
};
