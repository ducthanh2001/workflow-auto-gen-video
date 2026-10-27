import { z } from "zod";

import { DEFAULT_LIGHTING, LIGHTINGS } from "./sceneStyle";

export * from "./characterLock";
export * from "./sceneStyle";

// ---------- Scene schema (spec 4.1) ----------
export const Shot = z.enum(["wide", "medium", "close", "detail"]);
export const Camera = z.enum([
  "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "static",
]);
export const Motion = z.enum(["kenburns", "ai_clip"]);
export const TransitionOut = z.enum(["cut", "fade", "fadeblack", "dissolve"]);

/**
 * A person in a scene. The head, face and line style are locked by the style preset
 * (character_lock); only these fields may change from scene to scene.
 */
export const SceneCharacter = z.object({
  role: z.string().min(1), // "hero", "doctor", "villager"...
  hair: z.string().optional(), // "short grey scribbled hair"
  outfit: z.string().optional(), // "white lab coat"
  props: z.string().optional(), // "holding a lantern"
  expression: z.string().optional(), // "worried", "surprised"
  pose: z.string().optional(), // "pointing at a clock"
});
export const SceneCharacters = z.array(SceneCharacter).max(3);

/** Short words the picture itself must show (a sign, a label, "NO JOBS"). Lenient: cleaned, not rejected. */
export const cleanImageLabel = (s: string) => s.replace(/[\u0000-\u001f\u007f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
export const SceneImageText = z.array(z.string()).transform((a) => a.map(cleanImageLabel).filter(Boolean).slice(0, 3));

export const LightingSchema = z.enum(LIGHTINGS);

export const SceneDraft = z.object({
  beat: z.string(),
  narration: z.string().min(1), // verbatim slice of the script
  visual: z.string().min(10), // concrete, no text/letters/logos, no real people
  shot: Shot,
  camera: Camera,
  motion: Motion,
  transitionOut: TransitionOut,
  onScreenText: z.string().max(40).nullable(),
  /** people in the scene; [] = no people (no character sheet is attached) */
  characters: SceneCharacters.default([]),
  /** up to 3 short words drawn INSIDE the picture; [] = the picture has no text (the usual case) */
  imageText: SceneImageText.default([]),
  /** light and time of day: fixes the palette sentence of the image prompt (Scene Style Lock) */
  lighting: LightingSchema.catch(DEFAULT_LIGHTING).default(DEFAULT_LIGHTING),
});
export const ScenePlan = z.object({ scenes: z.array(SceneDraft).min(1) });

export type Shot = z.infer<typeof Shot>;
export type Camera = z.infer<typeof Camera>;
export type Motion = z.infer<typeof Motion>;
export type TransitionOut = z.infer<typeof TransitionOut>;
export type SceneCharacter = z.infer<typeof SceneCharacter>;
export type SceneDraft = z.infer<typeof SceneDraft>;
export type ScenePlan = z.infer<typeof ScenePlan>;

// ---------- Project state machine (spec 5) ----------
export const PROJECT_STATES = [
  "created", "parsed", "planned", "plan_approved",
  "refs_ready", "refs_approved",
  "voiced", "imaged", "images_approved",
  "motion_done", "draft_rendered", "draft_approved",
  "final_rendered", "thumbnails_ready", "metadata_ready", "done",
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const GATES = ["plan_approved", "refs_approved", "images_approved", "draft_approved"] as const;
export type Gate = (typeof GATES)[number];

export const STAGES = [
  "plan", "refs", "voice", "image", "clip", "render_draft", "render_final", "thumb", "metadata",
] as const;
export type Stage = (typeof STAGES)[number];

export const ASSET_TYPES = [
  "ref", "audio", "image", "clip", "segment", "chunk", "video", "thumbnail", "srt", "ass", "music_mix", "doc",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

// ---------- Project settings ----------
export const ProjectSettings = z.object({
  style: z.string().default("stickman-hero"),
  voice: z.string().default("narrator_calm"),
  fps: z.number().int().min(24).max(60).default(30),
  transitionSec: z.number().min(0).max(1.5).default(0.4),
  captions: z.boolean().default(true),
  musicTrackId: z.string().nullable().default(null),
  maxUsdPerRun: z.number().positive().default(40),
  maxAiClipShare: z.number().min(0).max(1).default(0.15),
  maxRetriesPerAsset: z.number().int().min(0).max(5).default(2),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const UpdateSettingsDto = ProjectSettings.partial();
export type UpdateSettingsDto = z.infer<typeof UpdateSettingsDto>;

// ---------- API DTOs ----------
export const CreateProjectDto = z.object({
  script: z.string().min(1).max(200 * 1024),
});
export type CreateProjectDto = z.infer<typeof CreateProjectDto>;

/** Scene fields a user may edit. `narration` is deliberately absent (immutable). */
export const UpdateSceneDto = z
  .object({
    visual: z.string().min(10),
    camera: Camera,
    shot: Shot,
    motion: Motion,
    transitionOut: TransitionOut,
    onScreenText: z.string().max(40).nullable(),
    characters: SceneCharacters,
    imageText: SceneImageText,
    lighting: LightingSchema,
    approved: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateSceneDto = z.infer<typeof UpdateSceneDto>;

export const RunDto = z.object({ to: z.enum(PROJECT_STATES) });
export type RunDto = z.infer<typeof RunDto>;

export const RenderDto = z.object({ mode: z.enum(["draft", "final"]) });
export type RenderDto = z.infer<typeof RenderDto>;

export const StageSceneIdsDto = z.object({ sceneIds: z.array(z.string()).optional() });

// ---------- Events (SSE) ----------
export interface ProjectEvent {
  type: "job" | "state" | "asset";
  projectId: string;
  at: string;
  data: Record<string, unknown>;
}
