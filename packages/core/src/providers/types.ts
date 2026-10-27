/** Provider interfaces (spec 3.1 and 18 step 5). Real and mock implementations satisfy these. */

export interface TtsRequest {
  text: string;
  voiceId: string;
  model: string;
  settings?: Record<string, unknown>;
  /** neighbouring scene text so prosody flows across scene boundaries */
  previousText?: string;
  nextText?: string;
}
export interface TtsResult {
  audio: Buffer;
  /** e.g. audio/mpeg or audio/wav */
  mime: string;
  costUsd: number;
}
export interface TtsProvider {
  readonly id: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export interface ImageRef {
  mime: string;
  data: Buffer;
}
export interface ImageRequest {
  prompt: string;
  refs: ImageRef[];
  aspect: "16:9";
}
export interface ImageResult {
  image: Buffer;
  mime: string;
  costUsd: number;
}
export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  /** false when the service cannot take reference pictures (the prompt must not talk about "attached" sheets) */
  readonly acceptsRefs?: boolean;
  /** how many reference pictures one call takes (default: several); 1 = a single model picture per call */
  readonly maxRefs?: number;
  generate(req: ImageRequest): Promise<ImageResult>;
}

export interface ClipRequest {
  image: Buffer;
  imageMime: string;
  prompt: string;
  seconds: number;
}
export interface ClipResult {
  video: Buffer;
  costUsd: number;
  seconds: number;
}
export interface VideoProvider {
  readonly id: string;
  readonly model: string;
  generate(req: ClipRequest): Promise<ClipResult>;
}

export interface Providers {
  llm: import("../planner").LlmClient;
  tts: TtsProvider;
  image: ImageProvider;
  video: VideoProvider | null;
}
