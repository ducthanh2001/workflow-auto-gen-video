/**
 * The orchestrator: state machine with approval gates (spec 5), budget guard (13),
 * per-scene regeneration with stale tracking, and the job lifecycle.
 *
 * The API calls the enqueue side; the worker calls `runJob`. Both share the DB,
 * so a job that finishes in the worker advances the project and keeps the run going.
 */
import { randomBytes } from "node:crypto";
import { In, type EntityManager } from "typeorm";
import sharp from "sharp";
import { UnrecoverableError, type Job as BullJob } from "bullmq";
import {
  BudgetExceededError, PlanError, ProviderError, ScriptError, assertBudget, buildImagePrompt, buildManualPlanPrompt, canApprove, estimateCost, fitTo16x9, importPlan, nextStep, parseScript,
  chooseRefs, planRun, redact, sceneHasPeople,
  type CostBreakdown,
} from "@vp/core";
import {
  GATES, PROJECT_STATES, ProjectSettings, type Gate, type ProjectState, type Stage, type UpdateSceneDto,
} from "@vp/shared";
import type { Ctx } from "./context";
import { Asset, Job, Project, Scene } from "./entities";
import { JOB_OPTIONS, STAGE_QUEUE, type StageJobData } from "./queues";
import { STAGE_FNS } from "./stages";
import { savePlan } from "./stages/plan";
import { saveScene } from "./stages/common";
import { writeReport } from "./stages/report";
import { markDownstreamStale } from "./stale";
import { projectKey } from "./storage";

export class PipelineError extends Error {
  constructor(message: string, public readonly httpStatus = 409) {
    super(message);
    this.name = "PipelineError";
  }
}

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";

export interface EstimateResult extends CostBreakdown {
  scenes: number;
  ttsChars: number;
  aiClips: number;
  spentUsd: number;
  capUsd: number;
  basedOn: "plan" | "script";
}

export class Pipeline {
  constructor(readonly ctx: Ctx) {}

  private get projects() {
    return this.ctx.ds.getRepository(Project);
  }
  private get scenesRepo() {
    return this.ctx.ds.getRepository(Scene);
  }
  private get jobsRepo() {
    return this.ctx.ds.getRepository(Job);
  }

  async getProject(id: string): Promise<Project> {
    const p = await this.projects.findOneBy({ id });
    if (!p) throw new PipelineError("project not found", 404);
    return p;
  }

  // ------------------------------------------------------------ create

  async createProject(script: string): Promise<{ project: Project; warnings: string[] }> {
    const parsed = parseScript(script); // throws ScriptError -> 400 in the API
    const cfg = this.ctx.cfg;
    if (!cfg.styles[parsed.meta.style]) throw new ScriptError(`Unknown style "${parsed.meta.style}". Available: ${Object.keys(cfg.styles).join(", ")}`);
    if (!cfg.voices[parsed.meta.voice]) throw new ScriptError(`Unknown voice "${parsed.meta.voice}". Available: ${Object.keys(cfg.voices).join(", ")}`);
    const settings = ProjectSettings.parse({
      style: parsed.meta.style,
      voice: parsed.meta.voice,
      fps: cfg.providers.timeline.fps,
      transitionSec: cfg.providers.timeline.transition,
    });
    const project = await this.projects.save(
      this.projects.create({
        slug: `${slugify(parsed.meta.title)}-${randomBytes(3).toString("hex")}`,
        title: parsed.meta.title,
        status: "parsed",
        settings,
        scriptRaw: script,
        meta: {
          sources: parsed.meta.sources, voice: parsed.meta.voice, style: parsed.meta.style,
          wordCount: parsed.wordCount, beats: parsed.beats.map((b) => b.title), warnings: parsed.warnings,
        },
        runTo: null, characterSheetAssetId: null, styleAnchorAssetId: null, stale: [],
      }),
    );
    return { project, warnings: parsed.warnings };
  }

  async deleteProject(id: string): Promise<void> {
    await this.getProject(id);
    await this.projects.delete({ id });
    await this.ctx.storage.removeDir(projectKey(id)).catch(() => undefined);
  }

  // ------------------------------------------------------------ cost

  async getSpent(projectId: string): Promise<number> {
    const r = await this.ctx.ds.query(`SELECT COALESCE(SUM("costUsd"),0) AS s FROM jobs WHERE "projectId" = $1`, [projectId]);
    return Number(r[0].s);
  }

  async estimate(projectId: string): Promise<EstimateResult> {
    const p = await this.getProject(projectId);
    const scenes = await this.scenesRepo.find({ where: { projectId } });
    const voice = this.ctx.cfg.voices[p.settings.voice];
    const planned = scenes.length > 0;
    const sceneCount = planned ? scenes.length : Math.ceil((p.meta.wordCount ?? 0) / 16);
    const ttsChars = planned ? scenes.reduce((a, s) => a + s.narration.length, 0) : Math.round((p.meta.wordCount ?? 0) * 5.8);
    const videoOn = !!this.ctx.providers.video && p.settings.maxAiClipShare > 0;
    const aiClips = videoOn ? (planned ? scenes.filter((s) => s.motion === "ai_clip").length : Math.floor(sceneCount * p.settings.maxAiClipShare)) : 0;
    const est = estimateCost(this.ctx.cfg.pricing, {
      ttsChars, ttsModel: voice?.model ?? "eleven_multilingual_v2", scenes: sceneCount,
      aiClips, clipSeconds: this.ctx.cfg.providers.video.clipSeconds, clipModel: this.ctx.cfg.providers.video.model,
    });
    return { ...est, scenes: sceneCount, ttsChars, aiClips, spentUsd: await this.getSpent(projectId), capUsd: p.settings.maxUsdPerRun, basedOn: planned ? "plan" : "script" };
  }

  private estimateStage(p: Project, stage: Stage, targets: Scene[]): number {
    const pr = this.ctx.cfg.pricing;
    const voice = this.ctx.cfg.voices[p.settings.voice];
    switch (stage) {
      case "plan": return pr.llm.usdPerPlanCall;
      case "refs": return 5 * pr.image.usdPerImage;
      case "voice": {
        const chars = targets.reduce((a, s) => a + s.narration.length, 0);
        return chars * (pr.tts.creditsPerChar[voice?.model ?? ""] ?? 1) * pr.tts.usdPerCredit;
      }
      case "image": return targets.length * pr.image.usdPerImage;
      case "clip": {
        const perSec = pr.clip.usdPerSecond[this.ctx.cfg.providers.video.model] ?? Object.values(pr.clip.usdPerSecond)[0] ?? 0.15;
        return targets.length * this.ctx.cfg.providers.video.clipSeconds * perSec;
      }
      case "thumb": return 3 * pr.image.usdPerImage + pr.llm.usdPerThumbConceptCall;
      case "metadata": return pr.llm.usdPerThumbConceptCall;
      default: return 0;
    }
  }

  // ------------------------------------------------------------ enqueue

  /** Which scenes a per-scene stage still has to process. */
  private needsWork(stage: Stage, scenes: Scene[], sceneIds: string[] | undefined, force: boolean): Scene[] {
    const pick = sceneIds ? scenes.filter((s) => sceneIds.includes(s.id)) : scenes;
    switch (stage) {
      case "voice": return pick.filter((s) => force || !s.audioAssetId);
      case "image": return pick.filter((s) => force || !s.imageAssetId);
      case "clip": return pick.filter((s) => s.motion === "ai_clip" && (force || !s.clipAssetId));
      default: return pick;
    }
  }

  /**
   * Enqueue a stage (fanning out per scene where relevant). Checks the budget first.
   * When there is nothing to do the stage completes immediately.
   */
  async enqueueStage(projectId: string, stage: Stage, opts: { sceneIds?: string[]; force?: boolean } = {}): Promise<{ queued: number }> {
    if (!this.ctx.queues) throw new Error("queues are not available in this process");
    const project = await this.getProject(projectId);
    const scenes = await this.scenesRepo.find({ where: { projectId }, order: { idx: "ASC" } });
    const perScene = stage === "voice" || stage === "image" || stage === "clip";
    if (perScene && !scenes.length) throw new PipelineError("the project has no scenes yet: run the plan first");

    if (stage === "clip") {
      // Without a provider (or with the cap at 0) AI clips quietly become Ken Burns.
      if (!this.ctx.providers.video || project.settings.maxAiClipShare <= 0) {
        await this.scenesRepo.update({ projectId, motion: "ai_clip" }, { motion: "kenburns" });
        return this.settleEmpty(projectId, stage);
      }
    }
    const targets = perScene ? this.needsWork(stage, scenes, opts.sceneIds, !!opts.force) : [];
    if (perScene && !targets.length) return this.settleEmpty(projectId, stage);

    const est = this.estimateStage(project, stage, targets);
    assertBudget(await this.getSpent(projectId), est, project.settings.maxUsdPerRun);

    const rows = await this.jobsRepo.save(
      (perScene ? targets : [null]).map((s) => this.jobsRepo.create({ projectId, sceneId: s?.id ?? null, stage, status: "queued", attempts: 0, error: null, costUsd: 0 })),
    );
    const queue = this.ctx.queues[STAGE_QUEUE[stage]];
    const backoff = Number(this.ctx.cfg.env.JOB_BACKOFF_MS ?? (JOB_OPTIONS.backoff as { delay: number }).delay);
    await queue.addBulk(
      rows.map((r) => ({
        name: stage,
        data: { jobId: r.id, projectId, stage, sceneId: r.sceneId ?? undefined } satisfies StageJobData,
        opts: { ...JOB_OPTIONS, backoff: { type: "exponential", delay: backoff }, jobId: r.id },
      })),
    );
    for (const r of rows) await this.ctx.events.publish(projectId, "job", { jobId: r.id, stage, sceneId: r.sceneId, status: "queued" });
    return { queued: rows.length };
  }

  private async settleEmpty(projectId: string, stage: Stage): Promise<{ queued: number }> {
    await this.completeStage(projectId, stage);
    return { queued: 0 };
  }

  // ------------------------------------------------------------ run / gates

  async run(projectId: string, to: ProjectState): Promise<Project> {
    await this.getProject(projectId);
    await this.projects.update(projectId, { runTo: to });
    await this.drive(projectId);
    return this.getProject(projectId);
  }

  /** Take the next step of the active run; stop at gates, at the target, or on a blocked stage. */
  async drive(projectId: string): Promise<void> {
    const p = await this.getProject(projectId);
    if (!p.runTo) return;
    const step = planRun(p.status, p.runTo);
    if (step.kind === "reached") {
      await this.projects.update(projectId, { runTo: null });
      return;
    }
    if (step.kind === "gate") {
      await this.ctx.events.publish(projectId, "state", { status: p.status, awaitingGate: step.gate });
      return;
    }
    if (step.kind === "finalize") {
      await writeReport(this.ctx, projectId).catch(() => undefined);
      await this.setStatus(projectId, step.becomes);
      await this.projects.update(projectId, { runTo: null });
      return;
    }
    if (step.kind === "stage") {
      if (await this.hasActiveJobs(projectId, step.stage)) return;
      try {
        await this.enqueueStage(projectId, step.stage);
      } catch (e) {
        if (e instanceof BudgetExceededError || e instanceof PipelineError) {
          await this.ctx.events.publish(projectId, "state", { status: p.status, blocked: step.stage, message: (e as Error).message });
          return;
        }
        throw e;
      }
    }
  }

  private async hasActiveJobs(projectId: string, stage: Stage): Promise<boolean> {
    return (await this.jobsRepo.count({ where: { projectId, stage, status: In(["queued", "running"]) } })) > 0;
  }

  private async setStatus(projectId: string, status: ProjectState): Promise<void> {
    await this.projects.update(projectId, { status });
    await this.ctx.events.publish(projectId, "state", { status });
  }

  async approve(projectId: string, gate: Gate): Promise<Project> {
    if (!GATES.includes(gate)) throw new PipelineError(`unknown gate "${gate}"`, 400);
    const p = await this.getProject(projectId);
    if (!canApprove(p.status, gate)) throw new PipelineError(`cannot approve ${gate} while the project is "${p.status}"`);

    const scenes = await this.scenesRepo.find({ where: { projectId } });
    if (gate === "plan_approved" && !scenes.length) throw new PipelineError("nothing to approve: no scenes");
    if (gate === "refs_approved" && (!p.characterSheetAssetId || !p.styleAnchorAssetId)) {
      throw new PipelineError("pick a style anchor (and a character sheet) before approving the references");
    }
    if (gate === "images_approved") {
      const missing = scenes.filter((s) => !s.imageAssetId).length;
      if (missing) throw new PipelineError(`${missing} scene(s) still have no image`);
      await this.scenesRepo.update({ projectId }, { approved: true });
    }
    if (gate === "draft_approved") {
      const draft = (await this.ctx.assets.list(projectId, "video")).find((a) => a.params.mode === "draft");
      if (!draft) throw new PipelineError("render a draft first");
      if (p.stale.includes("draft")) throw new PipelineError("the draft is out of date: render it again before approving");
    }
    await this.setStatus(projectId, gate);
    await this.drive(projectId);
    return this.getProject(projectId);
  }

  // ------------------------------------------------------------ completion

  private async stageComplete(em: EntityManager, p: Project, stage: Stage): Promise<{ ok: boolean; detail?: string }> {
    const scenes = await em.getRepository(Scene).find({ where: { projectId: p.id }, order: { idx: "ASC" } });
    const assets = em.getRepository(Asset);
    switch (stage) {
      case "plan": return { ok: scenes.length > 0 };
      case "refs": {
        const anchors = (await assets.find({ where: { projectId: p.id, type: "ref" } })).filter((a) => a.params.role === "anchor");
        return { ok: !!p.characterSheetAssetId && anchors.length > 0 };
      }
      case "voice": {
        const m = scenes.filter((s) => !s.audioAssetId);
        return { ok: !m.length, detail: m.length ? `${m.length} scene(s) without audio` : undefined };
      }
      case "image": {
        const m = scenes.filter((s) => !s.imageAssetId);
        return { ok: !m.length, detail: m.length ? `${m.length} scene(s) without an image` : undefined };
      }
      case "clip": return { ok: scenes.every((s) => s.motion !== "ai_clip" || !!s.clipAssetId) };
      case "render_draft":
      case "render_final": {
        const mode = stage === "render_draft" ? "draft" : "final";
        return { ok: (await assets.find({ where: { projectId: p.id, type: "video" } })).some((a) => a.params.mode === mode) };
      }
      case "thumb": return { ok: (await assets.count({ where: { projectId: p.id, type: "thumbnail" } })) >= 3 };
      case "metadata": return { ok: (await assets.find({ where: { projectId: p.id, type: "doc" } })).some((a) => a.params.kind === "metadata") };
    }
  }

  /** Advance the project when `stage` is the one it was waiting for and its outputs are complete. */
  async completeStage(projectId: string, stage: Stage): Promise<boolean> {
    const advanced = await this.ctx.ds.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [projectId]);
      const p = await em.getRepository(Project).findOneBy({ id: projectId });
      if (!p) return false;
      const step = nextStep(p.status);
      if (step.kind !== "stage" || step.stage !== stage) return false; // manual / repeat run: no state change
      const done = await this.stageComplete(em, p, stage);
      if (!done.ok) {
        const failed = await em.getRepository(Job).findOne({ where: { projectId, stage, status: "failed" }, order: { finishedAt: "DESC" } });
        const why = failed?.error ? `${stage} failed: ${failed.error}` : (done.detail ?? `${stage} is not complete`);
        await this.ctx.events.publish(projectId, "state", { status: p.status, blocked: stage, message: why.slice(0, 600) });
        return false;
      }
      await em.getRepository(Project).update(projectId, { status: step.becomes });
      await this.ctx.events.publish(projectId, "state", { status: step.becomes });
      return true;
    });
    if (advanced) await this.drive(projectId);
    return advanced;
  }

  async onJobSettled(projectId: string, stage: Stage): Promise<void> {
    if (await this.hasActiveJobs(projectId, stage)) return;
    await this.completeStage(projectId, stage);
  }

  /** Re-enqueue whatever is missing at the current stage (the Retry button). */
  async retry(projectId: string): Promise<{ queued: number }> {
    const p = await this.getProject(projectId);
    const step = nextStep(p.status);
    if (step.kind !== "stage") throw new PipelineError("nothing to retry: the project is waiting at a gate or is done");
    if (await this.hasActiveJobs(projectId, step.stage)) throw new PipelineError("this stage is still running");
    const key = step.stage === "voice" ? "voice" : step.stage === "image" ? "image" : step.stage === "clip" ? "clip" : null;
    if (key) {
      for (const s of await this.scenesRepo.find({ where: { projectId } })) {
        if (s.errors?.[key]) {
          s.errors = { ...s.errors, [key]: undefined };
          s.status = Object.values(s.errors).some(Boolean) ? "failed" : "pending";
          s.error = Object.values(s.errors).filter(Boolean).join("; ") || null;
          await this.scenesRepo.save(s);
        }
      }
    }
    if (!p.runTo) await this.projects.update(projectId, { runTo: step.becomes });
    return this.enqueueStage(projectId, step.stage);
  }

  // ------------------------------------------------------------ manual plan (no API key)

  /** The planner instructions plus the script, to paste into Claude desktop or claude.ai. */
  async manualPlanPrompt(projectId: string): Promise<string> {
    const p = await this.getProject(projectId);
    return buildManualPlanPrompt(parseScript(p.scriptRaw), this.ctx.providers.video ? p.settings.maxAiClipShare : 0);
  }

  /** Accept a plan made elsewhere. It goes through the same gates as the API planner (schema, verbatim, rules). */
  async importPlan(projectId: string, text: string): Promise<{ scenes: number; warnings: string[] }> {
    const p = await this.getProject(projectId);
    if (PROJECT_STATES.indexOf(p.status) >= PROJECT_STATES.indexOf("plan_approved")) {
      throw new PipelineError("the plan is already approved; create a new project to re-plan");
    }
    if (await this.hasActiveJobs(projectId, "plan")) throw new PipelineError("a plan job is still running");
    let result;
    try {
      const planner = this.ctx.cfg.providers.planner;
      result = importPlan(text, parseScript(p.scriptRaw), {
        maxAiClipShare: this.ctx.providers.video ? p.settings.maxAiClipShare : 0,
        defaultCamera: planner.defaultCamera,
        defaultTransition: planner.defaultTransition,
      });
    } catch (e) {
      if (e instanceof PlanError) throw new PipelineError(e.message, 400);
      throw e;
    }
    await savePlan(this.ctx, p, result.scenes, result.warnings);
    await this.projects.update(projectId, { status: "planned" });
    await this.ctx.events.publish(projectId, "state", { status: "planned" });
    await this.drive(projectId);
    return { scenes: result.scenes.length, warnings: result.warnings };
  }

  // ------------------------------------------------------------ scenes

  async updateScene(sceneId: string, dto: UpdateSceneDto): Promise<Scene> {
    const scene = await this.scenesRepo.findOneBy({ id: sceneId });
    if (!scene) throw new PipelineError("scene not found", 404);
    const before = { camera: scene.camera, motion: scene.motion, transitionOut: scene.transitionOut, onScreenText: scene.onScreenText };
    const charactersBefore = JSON.stringify(scene.characters ?? []);
    const imageTextBefore = JSON.stringify(scene.imageText ?? []);
    const lightingBefore = scene.lighting;
    Object.assign(scene, dto); // `narration` is not in UpdateSceneDto (strict schema) and never copied
    await this.scenesRepo.save(scene);
    const charactersChanged =
      (dto.characters !== undefined && JSON.stringify(dto.characters) !== charactersBefore) ||
      (dto.imageText !== undefined && JSON.stringify(dto.imageText) !== imageTextBefore) ||
      (dto.lighting !== undefined && dto.lighting !== lightingBefore);
    const renderChanged =
      charactersChanged || (Object.keys(before) as Array<keyof typeof before>).some((k) => dto[k] !== undefined && dto[k] !== before[k]);
    if (renderChanged) await markDownstreamStale(this.ctx, await this.getProject(scene.projectId), scene.id, "visual");
    return scene;
  }

  /** Redo one scene's asset; later products become stale (spec 5). */
  async regenerateScene(sceneId: string, stage: "voice" | "image" | "clip"): Promise<{ queued: number }> {
    const scene = await this.scenesRepo.findOneBy({ id: sceneId });
    if (!scene) throw new PipelineError("scene not found", 404);
    if (stage === "image") {
      const p = await this.getProject(scene.projectId);
      if (!p.characterSheetAssetId || !p.styleAnchorAssetId) throw new PipelineError("approve the references before generating images");
    }
    scene.gen = { ...scene.gen, [stage]: (scene.gen?.[stage] ?? 0) + 1 };
    scene.errors = { ...scene.errors, [stage]: undefined };
    if (stage === "clip" && scene.motion !== "ai_clip") scene.motion = "ai_clip";
    await this.scenesRepo.save(scene);
    return this.enqueueStage(scene.projectId, stage, { sceneIds: [scene.id], force: true });
  }

  /** What an image call for this scene sends (the "View prompt" box): prompt, references, model. */
  async scenePrompt(sceneId: string): Promise<{
    prompt: string; retryPrompt: string; references: string[]; style: string; model: string; hasPeople: boolean; lastError: string | null;
  }> {
    const scene = await this.scenesRepo.findOneBy({ id: sceneId });
    if (!scene) throw new PipelineError("scene not found", 404);
    const project = await this.getProject(scene.projectId);
    const style = this.ctx.cfg.styles[project.settings.style];
    if (!style) throw new PipelineError(`unknown style "${project.settings.style}"`, 400);
    const hasPeople = sceneHasPeople(scene.characters);
    const picked = chooseRefs(this.ctx.providers.image, scene.characters, { sheet: "Character sheet", anchor: "Style sample" });
    const input = {
      style, visual: scene.visual, shot: scene.shot, characters: scene.characters, imageText: scene.imageText, lighting: scene.lighting,
      attached: { sheet: picked.sheet, anchor: picked.anchor },
    };
    return {
      prompt: buildImagePrompt(input),
      retryPrompt: buildImagePrompt({ ...input, strongNoText: true }),
      references: picked.refs,
      style: style.name,
      model: this.ctx.providers.image.model ?? this.ctx.providers.image.id,
      hasPeople,
      lastError: scene.errors?.image ?? null,
    };
  }

  /**
   * Use the user's own picture for a scene (for example when image generation failed or the money ran out).
   * It is fitted to 16:9 like a generated image; later products become stale and the project advances
   * when this was the last missing image.
   */
  async uploadSceneImage(sceneId: string, data: Buffer): Promise<Asset> {
    const scene = await this.scenesRepo.findOneBy({ id: sceneId });
    if (!scene) throw new PipelineError("scene not found", 404);
    const project = await this.getProject(scene.projectId);
    const running = await this.jobsRepo.count({ where: { sceneId, stage: "image", status: In(["queued", "running"]) } });
    if (running) throw new PipelineError("an image job is still running for this scene; wait for it to finish", 409);

    let meta;
    try {
      meta = await sharp(data).rotate().metadata();
    } catch {
      throw new PipelineError("not a valid image", 400);
    }
    // rotate() applied the EXIF orientation, so these are the displayed sizes
    const srcW = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;
    const srcH = (meta.orientation ?? 1) >= 5 ? meta.width : meta.height;
    if (!srcW || !srcH || srcW < 512 || srcH < 288) throw new PipelineError("the image is too small (min 512x288)", 400);

    const [w, h] = this.ctx.cfg.providers.image.upscaleTo;
    const oriented = await sharp(data).rotate().toBuffer();
    const fitted = await fitTo16x9(oriented, w, h);
    const jpg = await sharp(fitted).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    const key = projectKey(project.id, "images", `s${String(scene.idx + 1).padStart(4, "0")}-upload-${randomBytes(4).toString("hex")}.jpg`);
    const bytes = await this.ctx.storage.put(key, jpg);
    const cropped = Math.abs(srcW / srcH - 16 / 9) > 0.02;
    const asset = await this.ctx.assets.create({
      projectId: project.id, sceneId: scene.id, type: "image", storageKey: key, mime: "image/jpeg", provider: "upload",
      params: { uploaded: true, width: w, height: h, sourceWidth: srcW, sourceHeight: srcH, ...(cropped ? { croppedTo16x9: true } : {}) }, bytes,
    });

    scene.imageAssetId = asset.id;
    scene.errors = { ...scene.errors, image: undefined };
    await saveScene(this.ctx, scene);
    await markDownstreamStale(this.ctx, project, scene.id, "image");
    await this.ctx.events.publish(project.id, "asset", { kind: "image", sceneId: scene.id, assetId: asset.id, uploaded: true });
    await this.completeStage(project.id, "image"); // no-op unless the project was waiting on the image stage
    return asset;
  }

  // ------------------------------------------------------------ refs

  async regenerateRefs(projectId: string): Promise<{ queued: number }> {
    const p = await this.getProject(projectId);
    if (p.status === "created" || p.status === "parsed" || p.status === "planned") throw new PipelineError("approve the plan before generating references");
    await this.projects.update(projectId, { meta: { ...p.meta, refsGen: (p.meta.refsGen ?? 0) + 1 } });
    return this.enqueueStage(projectId, "refs");
  }

  async selectRefs(projectId: string, input: { anchorAssetId: string; characterSheetAssetId?: string }): Promise<Project> {
    const p = await this.getProject(projectId);
    const ids = [input.anchorAssetId, ...(input.characterSheetAssetId ? [input.characterSheetAssetId] : [])];
    const found = await this.ctx.ds.getRepository(Asset).findBy({ id: In(ids), projectId, type: "ref" });
    if (found.length !== ids.length) throw new PipelineError("reference asset not found in this project", 404);
    const anchor = found.find((a) => a.id === input.anchorAssetId)!;
    if (anchor.params.role !== "anchor") throw new PipelineError("that asset is not a style anchor", 400);
    await this.projects.update(projectId, {
      styleAnchorAssetId: anchor.id,
      ...(input.characterSheetAssetId ? { characterSheetAssetId: input.characterSheetAssetId } : {}),
    });
    await this.ctx.events.publish(projectId, "asset", { kind: "refs_selected" });
    return this.getProject(p.id);
  }

  /** The user may bring their own original character sheet (originality rule, spec 1). */
  async uploadCharacterSheet(projectId: string, data: Buffer): Promise<Asset> {
    const p = await this.getProject(projectId);
    let meta;
    try {
      meta = await sharp(data).metadata();
    } catch {
      throw new PipelineError("not a valid image", 400);
    }
    if (!meta.width || !meta.height || meta.width < 512 || meta.height < 256) throw new PipelineError("the image is too small (min 512x256)", 400);
    const jpg = await sharp(data).resize(1920, 1080, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    const key = projectKey(projectId, "refs", `character_sheet-upload-${randomBytes(4).toString("hex")}.jpg`);
    const bytes = await this.ctx.storage.put(key, jpg);
    const asset = await this.ctx.assets.create({
      projectId, type: "ref", storageKey: key, mime: "image/jpeg", params: { role: "character_sheet", uploaded: true }, bytes,
    });
    await this.projects.update(projectId, { characterSheetAssetId: asset.id });
    await this.ctx.events.publish(p.id, "asset", { kind: "refs_selected" });
    return asset;
  }

  // ------------------------------------------------------------ job lifecycle (worker side)

  /** Execute one stage job; records status, cost and errors, then lets the project advance. */
  async runJob(job: Pick<BullJob<StageJobData>, "data" | "attemptsMade" | "opts">): Promise<void> {
    const { data } = job;
    const row = await this.jobsRepo.findOneBy({ id: data.jobId });
    if (!row) return; // project was deleted meanwhile
    const maxAttempts = job.opts?.attempts ?? 1;
    row.status = "running";
    row.attempts = job.attemptsMade + 1;
    row.startedAt ??= new Date();
    await this.jobsRepo.save(row);
    await this.ctx.events.publish(data.projectId, "job", { jobId: row.id, stage: data.stage, sceneId: row.sceneId, status: "running", attempt: row.attempts });

    try {
      const res = await STAGE_FNS[data.stage](this.ctx, data);
      row.status = "succeeded";
      row.costUsd = res.costUsd;
      row.error = res.note ?? null;
      row.finishedAt = new Date();
      await this.jobsRepo.save(row);
      // every provider call is logged with project/scene id and cost (never keys or signed URLs)
      this.ctx.log("job succeeded", { projectId: data.projectId, sceneId: row.sceneId, stage: data.stage, costUsd: res.costUsd, attempt: row.attempts });
      await this.ctx.events.publish(data.projectId, "job", { jobId: row.id, stage: data.stage, sceneId: row.sceneId, status: "succeeded", costUsd: res.costUsd });
    } catch (e) {
      const msg = redact((e as Error).message ?? String(e)).slice(0, 1500);
      const unrecoverable =
        (e instanceof ProviderError && !e.retriable) ||
        e instanceof BudgetExceededError ||
        e instanceof PipelineError ||
        ["ScriptError", "PlanError"].includes((e as Error).name);
      const final = unrecoverable || job.attemptsMade + 1 >= maxAttempts;
      row.error = msg;
      row.status = final ? "failed" : "queued";
      if (final) row.finishedAt = new Date();
      await this.jobsRepo.save(row);
      this.ctx.log(final ? "job failed" : "job will retry", { projectId: data.projectId, sceneId: row.sceneId, stage: data.stage, attempt: row.attempts, error: msg.slice(0, 300) });
      await this.ctx.events.publish(data.projectId, "job", { jobId: row.id, stage: data.stage, sceneId: row.sceneId, status: row.status, error: msg });
      if (final) {
        if (row.sceneId && (data.stage === "voice" || data.stage === "image" || data.stage === "clip")) {
          const s = await this.scenesRepo.findOneBy({ id: row.sceneId });
          if (s) {
            s.errors = { ...s.errors, [data.stage]: msg };
            s.status = "failed";
            s.error = Object.values(s.errors).filter(Boolean).join("; ");
            await this.scenesRepo.save(s);
          }
        }
        await this.onJobSettled(data.projectId, data.stage).catch(() => undefined);
        if (unrecoverable) throw new UnrecoverableError(msg);
      }
      throw e;
    }
    await this.onJobSettled(data.projectId, data.stage);
  }
}
