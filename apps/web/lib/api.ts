/** Typed fetch helpers. Everything goes through /api (proxied to NestJS); no secrets live in the browser. */
import type { Gate, ProjectSettings, ProjectState } from "@vp/shared";

export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: Record<string, unknown>) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const b = (json ?? {}) as { message?: string | string[] };
    const msg = Array.isArray(b.message) ? b.message.join("; ") : (b.message ?? (text.slice(0, 200) || res.statusText));
    throw new ApiError(msg, res.status, json as Record<string, unknown>);
  }
  return json as T;
}

export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b: unknown) => req<T>("PATCH", p, b),
  del: <T>(p: string) => req<T>("DELETE", p),
  upload: <T>(p: string, form: FormData) => req<T>("POST", p, undefined, form),
};

// ---- response shapes (mirror apps/api) ---------------------------------------------

export interface ProjectView {
  id: string;
  slug: string;
  title: string;
  status: ProjectState;
  settings: ProjectSettings;
  meta: { sources?: string[]; wordCount?: number; beats?: string[]; warnings?: string[]; planWarnings?: string[]; clipFallbacks?: number[] };
  runTo: ProjectState | null;
  stale: string[];
  createdAt: string;
  spentUsd: number;
  awaitingGate: Gate | null;
  nextStage: string | null;
  activeJobs: number;
  styleAnchorAssetId: string | null;
  characterSheetAssetId: string | null;
  warnings?: string[];
}

export interface SceneView {
  id: string;
  idx: number;
  beat: string;
  narration: string;
  visual: string;
  /** people in the scene; null = planned before characters existed */
  characters: Array<{ role: string; hair?: string; outfit?: string; props?: string; expression?: string; pose?: string }> | null;
  /** short words drawn inside the picture; [] = no text */
  imageText: string[];
  /** light and time of day (golden_hour, midday, dusk, night, indoor_warm, indoor_cool, overcast) */
  lighting: string;
  shot: string;
  camera: string;
  motion: string;
  transitionOut: string;
  onScreenText: string | null;
  approved: boolean;
  status: "pending" | "ready" | "failed";
  error: string | null;
  errors: Record<string, string | undefined>;
  audioDurationSec: number | null;
  audioUrl: string | null;
  imageUrl: string | null;
  clipUrl: string | null;
  stale: boolean;
}

/** What an image call for one scene sends: the text prompt and which reference pictures go with it. */
export interface ScenePrompt {
  prompt: string;
  retryPrompt: string;
  references: string[];
  style: string;
  model: string;
  hasPeople: boolean;
  lastError: string | null;
}

export interface Estimate {
  plan: number; refs: number; tts: number; images: number; clips: number; thumbnails: number; total: number;
  scenes: number; ttsChars: number; aiClips: number; spentUsd: number; capUsd: number; basedOn: "plan" | "script";
}

export interface Output {
  id: string;
  type: "video" | "srt" | "ass" | "thumbnail" | "doc";
  kind: string | null;
  stale: boolean;
  bytes: number;
  name: string;
  url: string;
  params?: Record<string, unknown>;
}

export interface JobView {
  id: string; sceneId: string | null; stage: string; status: string; attempts: number; error: string | null; costUsd: number; createdAt: string;
}

export interface MusicTrack {
  id: string; name: string; durationSec: number; licenseNote: string; createdAt: string;
}

export interface TimelineView {
  ready: boolean;
  totalSec: number;
  scenes: Array<{ idx: number; beat: string; startSec: number; speechStartSec: number }>;
  chapters: Array<{ title: string; startSec: number }>;
}

export interface RefsView {
  characterSheets: Array<{ id: string; url: string; uploaded: boolean; global: boolean; selected: boolean }>;
  /** modern-outfit hero sheets (and drafts waiting to be saved as the global one) */
  modernSheets: Array<{ id: string; url: string; draft: boolean; global: boolean; selected: boolean }>;
  anchors: Array<{ id: string; url: string; selected: boolean; global: boolean }>;
  /** CHARACTER_LOCK_VERSION the references were made with; null for projects of the older styles */
  lockVersion: number | null;
}

/** Which global hero files exist (one approved hero for every project). */
export interface GlobalHeroStatus {
  sheet: boolean;
  modern: boolean;
  reference: boolean;
  /** the style sample: one finished scene every picture copies the painting style of */
  anchor: boolean;
  lockVersion: number;
}

export interface DepsReport {
  ok: boolean;
  ffmpeg: { ok: boolean; version?: string; missing: string[]; amixNormalize?: boolean; error?: string };
  fonts: { ok: boolean; missing: string[] };
  db: { ok: boolean; error?: string };
  redis: { ok: boolean; error?: string };
  keys: Record<string, "configured" | "missing">;
  mockProviders: boolean;
  warnings: string[];
}

export interface ScriptPreview {
  ok: boolean;
  error?: string;
  title?: string;
  voice?: string;
  style?: string;
  sources?: string[];
  wordCount?: number;
  estimatedMinutes?: number;
  beats?: Array<{ title: string; words: number }>;
  warnings?: string[];
  voiceKnown?: boolean;
  styleKnown?: boolean;
}
