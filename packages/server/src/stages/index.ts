import type { Stage } from "@vp/shared";
import type { StageFn } from "./common";
import { planStage } from "./plan";
import { refsStage } from "./refs";
import { voiceStage } from "./voice";
import { imageStage } from "./image";
import { clipStage } from "./clip";
import { renderStage } from "./render";
import { thumbStage } from "./thumb";
import { metadataStage } from "./metadata";

export const STAGE_FNS: Record<Stage, StageFn> = {
  plan: planStage,
  refs: refsStage,
  voice: voiceStage,
  image: imageStage,
  clip: clipStage,
  render_draft: renderStage,
  render_final: renderStage,
  thumb: thumbStage,
  metadata: metadataStage,
};

export * from "./common";
export { writeReport } from "./report";
export { applyGlobalHero, generateModernSheet } from "./refs";
