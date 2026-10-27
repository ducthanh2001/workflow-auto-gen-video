/** Server configuration: env + config/*.json + config/styles/*.yaml. Secrets stay on the server. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Camera, TransitionOut } from "@vp/shared";
import {
  AnthropicLlm, ApizImage, ElevenLabsTts, FalVideo, GeminiImage, MockImage, MockLlm, MockTts, MockVideo, ProviderError,
  assertOriginalStyle, parseStyle,
  type ImageProvider, type LlmClient, type Pricing, type Providers, type StylePreset, type TtsProvider, type VideoProvider,
} from "@vp/core";

export interface VoiceConfig {
  label: string;
  provider: "elevenlabs";
  voiceId: string;
  model: string;
  commercialUseConfirmed: boolean;
  settings?: Record<string, unknown>;
}

export interface ProvidersConfig {
  tts: { provider: string; concurrency: number };
  image: { provider: string; concurrency: number; variants: number; upscaleTo: [number, number] };
  video: { provider: string; model: string; clipSeconds: number; concurrency: number };
  /** defaultCamera / defaultTransition: applied to every planned or imported scene (see enforcePlanRules) */
  planner: { provider: string; maxVerbatimRetries: number; defaultCamera?: Camera; defaultTransition?: TransitionOut };
  timeline: { fps: number; lead: number; tail: number; tailBeat: number; transition: number; chunkSize: number };
  audio: { musicGainDb: number; musicFadeIn: number; musicFadeOut: number; targetLufs: number; truePeak: number; lra: number };
}

export interface AppConfig {
  dataDir: string;
  configDir: string;
  assetsDir: string;
  fontsDir: string;
  appPassword: string;
  databaseUrl: string;
  redisUrl: string;
  voices: Record<string, VoiceConfig>;
  providers: ProvidersConfig;
  pricing: Pricing & { clip: { usdPerSecond: Record<string, number> } };
  styles: Record<string, StylePreset>;
  mockProviders: boolean;
  env: NodeJS.ProcessEnv;
}

function findUp(start: string, rel: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, rel);
    if (existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configDir = env.CONFIG_DIR ? path.resolve(env.CONFIG_DIR) : findUp(process.cwd(), "config/providers.json")?.replace(/providers\.json$/, "").replace(/[\\/]$/, "");
  if (!configDir) throw new Error("config/ directory not found (set CONFIG_DIR)");
  const assetsDir = env.ASSETS_DIR ? path.resolve(env.ASSETS_DIR) : path.resolve(configDir, "..", "assets");
  const json = <T>(f: string) => JSON.parse(readFileSync(path.join(configDir, f), "utf8")) as T;

  const styles: Record<string, StylePreset> = {};
  const stylesDir = path.join(configDir, "styles");
  for (const f of readdirSync(stylesDir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const s = parseStyle(readFileSync(path.join(stylesDir, f), "utf8"));
    assertOriginalStyle(s);
    styles[s.name] = s;
  }

  const voices = json<Record<string, VoiceConfig>>("voices.json");
  const providers = json<ProvidersConfig>("providers.json");
  const { defaultCamera, defaultTransition } = providers.planner;
  if (defaultCamera !== undefined && !Camera.safeParse(defaultCamera).success) {
    throw new Error(`config/providers.json planner.defaultCamera "${defaultCamera}" is not one of ${Camera.options.join(", ")}`);
  }
  if (defaultTransition !== undefined && !TransitionOut.safeParse(defaultTransition).success) {
    throw new Error(`config/providers.json planner.defaultTransition "${defaultTransition}" is not one of ${TransitionOut.options.join(", ")}`);
  }
  return {
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    configDir,
    assetsDir,
    fontsDir: path.join(assetsDir, "fonts"),
    appPassword: env.APP_PASSWORD ?? "",
    databaseUrl: env.DATABASE_URL ?? "postgres://vp:vp@localhost:5432/vp",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    voices: Object.fromEntries(Object.entries(voices).filter(([k]) => !k.startsWith("_"))),
    providers,
    pricing: json("pricing.json"),
    styles,
    mockProviders: env.PROVIDERS === "mock",
    env,
  };
}

/** Which secrets are configured. Never returns values (spec 3.4). */
export function keyStatus(env: NodeJS.ProcessEnv = process.env): Record<string, "configured" | "missing"> {
  const has = (k: string) => (env[k] && env[k]!.trim() ? "configured" : "missing");
  return {
    ANTHROPIC_API_KEY: has("ANTHROPIC_API_KEY"),
    ELEVENLABS_API_KEY: has("ELEVENLABS_API_KEY"),
    GEMINI_API_KEY: has("GEMINI_API_KEY"),
    GEMINI_IMAGE_MODEL: has("GEMINI_IMAGE_MODEL"),
    APIZ_API_KEY: has("APIZ_API_KEY"),
    APIZ_IMAGE_MODEL: has("APIZ_IMAGE_MODEL"),
    FAL_API_KEY: has("FAL_API_KEY"),
  };
}

/**
 * Which service draws the pictures. `IMAGE_PROVIDER=apiz|gemini` decides; when it is not set,
 * APIZ is used as soon as both APIZ_API_KEY and APIZ_IMAGE_MODEL are filled in, otherwise Gemini.
 */
export function imageProviderChoice(env: NodeJS.ProcessEnv = process.env): "apiz" | "gemini" {
  const forced = env.IMAGE_PROVIDER?.trim().toLowerCase();
  if (forced === "apiz" || forced === "gemini") return forced;
  return env.APIZ_API_KEY?.trim() && env.APIZ_IMAGE_MODEL?.trim() ? "apiz" : "gemini";
}

class MissingProvider {
  constructor(private readonly what: string) {}
  private fail(): never {
    throw new ProviderError(`${this.what} is not configured on the server`, undefined, false, "invalid");
  }
  readonly id = "missing";
  readonly model = "missing";
  complete = () => this.fail();
  synthesize = () => this.fail();
  generate = () => this.fail();
}

export function createProviders(cfg: AppConfig): Providers {
  if (cfg.mockProviders) {
    return { llm: new MockLlm(), tts: new MockTts(), image: new MockImage(), video: new MockVideo() };
  }
  const e = cfg.env;
  const llm: LlmClient = e.ANTHROPIC_API_KEY
    ? new AnthropicLlm({ apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL || "claude-sonnet-5-5", costPerCallUsd: cfg.pricing.llm.usdPerPlanCall })
    : (new MissingProvider("ANTHROPIC_API_KEY") as unknown as LlmClient);
  const tts: TtsProvider = e.ELEVENLABS_API_KEY
    ? new ElevenLabsTts({ apiKey: e.ELEVENLABS_API_KEY, creditsPerChar: cfg.pricing.tts.creditsPerChar, usdPerCredit: cfg.pricing.tts.usdPerCredit })
    : (new MissingProvider("ELEVENLABS_API_KEY") as unknown as TtsProvider);
  const usdPerImage = cfg.pricing.image.usdPerImage;
  const image: ImageProvider =
    imageProviderChoice(e) === "apiz"
      ? e.APIZ_API_KEY?.trim() && e.APIZ_IMAGE_MODEL?.trim()
        ? new ApizImage({
            apiKey: e.APIZ_API_KEY.trim(), model: e.APIZ_IMAGE_MODEL.trim(), usdPerImage,
            size: e.APIZ_IMAGE_SIZE?.trim() || undefined, baseUrl: e.APIZ_BASE_URL?.trim() || undefined,
          })
        : (new MissingProvider("APIZ_API_KEY / APIZ_IMAGE_MODEL") as unknown as ImageProvider)
      : e.GEMINI_API_KEY && e.GEMINI_IMAGE_MODEL
        ? new GeminiImage({ apiKey: e.GEMINI_API_KEY, model: e.GEMINI_IMAGE_MODEL, usdPerImage })
        : (new MissingProvider("GEMINI_API_KEY / GEMINI_IMAGE_MODEL") as unknown as ImageProvider);
  const modelKey = cfg.providers.video.model;
  const perSec = cfg.pricing.clip.usdPerSecond[modelKey] ?? Object.values(cfg.pricing.clip.usdPerSecond)[0] ?? 0.15;
  const video: VideoProvider | null = e.FAL_API_KEY
    ? new FalVideo({ apiKey: e.FAL_API_KEY, model: modelKey, usdPerSecond: perSec })
    : null;
  return { llm, tts, image, video };
}
