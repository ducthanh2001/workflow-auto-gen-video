/** Cost estimator and budget guard (spec 15). Prices come from config/pricing.json. */

export interface Pricing {
  tts: { usdPerCredit: number; creditsPerChar: Record<string, number> };
  image: { usdPerImage: number };
  clip: { usdPerSecond: Record<string, number> };
  llm: { usdPerPlanCall: number; usdPerThumbConceptCall: number };
}

export interface EstimateInput {
  ttsChars: number;
  ttsModel: string;
  scenes: number;
  /** images per scene (variants) */
  imagesPerScene?: number;
  /** extra images for refs (character sheet + anchors) and thumbnails */
  refImages?: number;
  thumbnailImages?: number;
  aiClips: number;
  clipSeconds: number;
  clipModel: string;
}

export interface CostBreakdown {
  plan: number;
  refs: number;
  tts: number;
  images: number;
  clips: number;
  thumbnails: number;
  total: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export function estimateCost(p: Pricing, i: EstimateInput): CostBreakdown {
  const credits = (p.tts.creditsPerChar[i.ttsModel] ?? 1) * i.ttsChars;
  const tts = credits * p.tts.usdPerCredit;
  const images = i.scenes * (i.imagesPerScene ?? 1) * p.image.usdPerImage;
  const refs = (i.refImages ?? 5) * p.image.usdPerImage;
  const thumbnails = (i.thumbnailImages ?? 3) * p.image.usdPerImage + p.llm.usdPerThumbConceptCall;
  const clips = i.aiClips * i.clipSeconds * (p.clip.usdPerSecond[i.clipModel] ?? 0.15);
  const plan = p.llm.usdPerPlanCall;
  const total = plan + refs + tts + images + clips + thumbnails;
  return {
    plan: round(plan),
    refs: round(refs),
    tts: round(tts),
    images: round(images),
    clips: round(clips),
    thumbnails: round(thumbnails),
    total: round(total),
  };
}

export class BudgetExceededError extends Error {
  constructor(public readonly spent: number, public readonly estimate: number, public readonly cap: number) {
    super(
      `Budget cap exceeded: spent $${spent.toFixed(2)} + estimate $${estimate.toFixed(2)} > cap $${cap.toFixed(2)}`,
    );
    this.name = "BudgetExceededError";
  }
}

/** Throws unless spent + estimate <= cap. */
export function assertBudget(spent: number, estimate: number, cap: number): void {
  if (spent + estimate > cap + 1e-9) throw new BudgetExceededError(spent, estimate, cap);
}

export function checkBudget(spent: number, estimate: number, cap: number) {
  return { ok: spent + estimate <= cap + 1e-9, spent, estimate, cap, remaining: cap - spent };
}
