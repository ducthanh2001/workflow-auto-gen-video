import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Sse, UploadedFile, UseInterceptors,
  type MessageEvent,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Observable } from "rxjs";
import { In } from "typeorm";
import { z } from "zod";
import { buildChapters, buildTimeline, nextStep, parseScript, ScriptError, verbatimCheck } from "@vp/core";
import {
  GATES, PROJECT_STATES, RenderDto, RunDto, StageSceneIdsDto, UpdateSettingsDto, type Gate, type ProjectState,
} from "@vp/shared";
import { Asset, Job, Project, Scene, MusicTrack, type Ctx, type Pipeline } from "@vp/server";
import { CTX, PIPELINE, ZodPipe } from "./common";

const MAX_SCRIPT = 200 * 1024;
const assetUrl = (id: string | null | undefined) => (id ? `/assets/${id}/content` : null);

const SelectRefsDto = z.object({ anchorAssetId: z.string().uuid(), characterSheetAssetId: z.string().uuid().optional() });

@Controller()
export class ProjectsController {
  constructor(
    @Inject(CTX) private readonly ctx: Ctx,
    @Inject(PIPELINE) private readonly pipeline: Pipeline,
  ) {}

  private async view(p: Project) {
    const step = nextStep(p.status);
    const active = await this.ctx.ds.getRepository(Job).count({ where: { projectId: p.id, status: In(["queued", "running"]) } });
    return {
      id: p.id, slug: p.slug, title: p.title, status: p.status, settings: p.settings, meta: p.meta, runTo: p.runTo, stale: p.stale,
      createdAt: p.createdAt,
      characterSheetUrl: assetUrl(p.characterSheetAssetId), styleAnchorAssetId: p.styleAnchorAssetId, characterSheetAssetId: p.characterSheetAssetId,
      spentUsd: await this.pipeline.getSpent(p.id),
      awaitingGate: step.kind === "gate" ? step.gate : null,
      nextStage: step.kind === "stage" ? step.stage : null,
      activeJobs: active,
    };
  }

  @Post("projects")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_SCRIPT + 1024 } }))
  async create(@Body() body: { script?: string }, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    let script = body?.script;
    if (file) {
      if (!/\.(md|txt)$/i.test(file.originalname)) throw new BadRequestException("only .md or .txt scripts are accepted");
      script = file.buffer.toString("utf8");
    }
    if (typeof script !== "string" || !script.trim()) throw new BadRequestException("send `script` (text) or a `file`");
    if (Buffer.byteLength(script) > MAX_SCRIPT) throw new BadRequestException("script is larger than 200 KB");
    const { project, warnings } = await this.pipeline.createProject(script);
    return { ...(await this.view(project)), warnings };
  }

  /** Parse without saving: beats, word count and warnings for the new-project screen. */
  @Post("projects/preview")
  preview(@Body() body: { script?: string }) {
    if (typeof body?.script !== "string" || !body.script.trim()) throw new BadRequestException("send the script text as `script`");
    try {
      const p = parseScript(body.script);
      return {
        ok: true, title: p.meta.title, voice: p.meta.voice, style: p.meta.style, sources: p.meta.sources, wordCount: p.wordCount,
        estimatedMinutes: Math.round((p.wordCount / 190) * 10) / 10,
        beats: p.beats.map((b) => ({ title: b.title, words: b.paragraphs.join(" ").split(/\s+/).length })), warnings: p.warnings,
        voiceKnown: !!this.ctx.cfg.voices[p.meta.voice], styleKnown: !!this.ctx.cfg.styles[p.meta.style],
      };
    } catch (e) {
      if (e instanceof ScriptError) return { ok: false, error: e.message };
      throw e;
    }
  }

  /** Scene start times and chapters, for the player markers (computed by the same timeline code the render uses). */
  @Get("projects/:id/timeline")
  async timeline(@Param("id", ParseUUIDPipe) id: string) {
    const p = await this.pipeline.getProject(id);
    const scenes = await this.ctx.ds.getRepository(Scene).find({ where: { projectId: id }, order: { idx: "ASC" } });
    if (!scenes.length || scenes.some((s) => !s.audioDurationSec)) return { ready: false, totalSec: 0, scenes: [], chapters: [] };
    const t = this.ctx.cfg.providers.timeline;
    const tl = buildTimeline(
      scenes.map((s) => ({ beat: s.beat, audioSec: s.audioDurationSec!, transitionOut: s.transitionOut })),
      { fps: p.settings.fps, lead: t.lead, tail: t.tail, tailBeat: t.tailBeat, transition: p.settings.transitionSec },
    );
    return {
      ready: true, totalSec: tl.totalSec,
      scenes: tl.scenes.map((s) => ({ idx: s.idx, beat: s.beat, startSec: s.startSec, speechStartSec: s.speechStartSec })),
      chapters: buildChapters(tl).chapters,
    };
  }

  /** Re-checks that the stored scenes still reproduce the script word for word (the badge in the plan panel). */
  @Get("projects/:id/verbatim")
  async verbatim(@Param("id", ParseUUIDPipe) id: string) {
    const p = await this.pipeline.getProject(id);
    const scenes = await this.ctx.ds.getRepository(Scene).find({ where: { projectId: id }, order: { idx: "ASC" } });
    if (!scenes.length) return { ok: false, planned: false };
    const parsed = parseScript(p.scriptRaw);
    return { planned: true, ...verbatimCheck(parsed.narration, scenes.map((s) => s.narration)) };
  }

  @Get("projects")
  async list() {
    const rows = await this.ctx.ds.getRepository(Project).find({ order: { createdAt: "DESC" } });
    return Promise.all(rows.map((p) => this.view(p)));
  }

  @Get("projects/:id")
  async get(@Param("id", ParseUUIDPipe) id: string) {
    return this.view(await this.pipeline.getProject(id));
  }

  @Delete("projects/:id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.pipeline.deleteProject(id);
    return { ok: true };
  }

  @Patch("projects/:id/settings")
  async settings(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateSettingsDto)) dto: UpdateSettingsDto) {
    const p = await this.pipeline.getProject(id);
    const idx = (s: ProjectState) => PROJECT_STATES.indexOf(s);
    if (dto.style && dto.style !== p.settings.style) {
      if (!this.ctx.cfg.styles[dto.style]) throw new BadRequestException(`unknown style "${dto.style}"`);
      // references drawn in the old style can still be regenerated while they wait for approval
      if (idx(p.status) >= idx("refs_approved")) throw new BadRequestException("the style cannot change once the references are approved");
    }
    if (dto.voice && dto.voice !== p.settings.voice) {
      if (!this.ctx.cfg.voices[dto.voice]) throw new BadRequestException(`unknown voice "${dto.voice}"`);
      if (idx(p.status) >= idx("voiced")) throw new BadRequestException("the voice cannot change once the narration is generated");
    }
    if (dto.musicTrackId) {
      const t = await this.ctx.ds.getRepository(MusicTrack).findOneBy({ id: dto.musicTrackId });
      if (!t) throw new BadRequestException("music track not found");
    }
    const renderAffecting = ["captions", "musicTrackId", "transitionSec", "fps"] as const;
    const changed = renderAffecting.some((k) => dto[k] !== undefined && dto[k] !== p.settings[k]);
    const stale = new Set(p.stale);
    if (changed) for (const v of await this.ctx.assets.list(id, "video")) stale.add(String(v.params.mode ?? "final"));
    await this.ctx.ds.getRepository(Project).update(id, { settings: { ...p.settings, ...dto }, stale: [...stale] });
    return this.view(await this.pipeline.getProject(id));
  }

  // ---- stages ----------------------------------------------------------------

  @Post("projects/:id/plan")
  async plan(@Param("id", ParseUUIDPipe) id: string) {
    const p = await this.pipeline.getProject(id);
    if (PROJECT_STATES.indexOf(p.status) >= PROJECT_STATES.indexOf("plan_approved")) {
      throw new BadRequestException("the plan is already approved; create a new project to re-plan");
    }
    await this.ctx.ds.getRepository(Project).update(id, { status: "parsed" });
    return this.pipeline.enqueueStage(id, "plan");
  }

  /** The planner instructions + script as one text, to paste into Claude desktop (no API key needed). */
  @Get("projects/:id/plan/prompt")
  async planPrompt(@Param("id", ParseUUIDPipe) id: string) {
    return { prompt: await this.pipeline.manualPlanPrompt(id) };
  }

  /** Import a plan made elsewhere; same gates as the API planner (schema, verbatim check, rules). */
  @Post("projects/:id/plan/import")
  async planImport(@Param("id", ParseUUIDPipe) id: string, @Body() body: { text?: string }) {
    if (typeof body?.text !== "string" || !body.text.trim()) throw new BadRequestException("paste the JSON plan as `text`");
    return this.pipeline.importPlan(id, body.text);
  }

  @Get("projects/:id/scenes")
  async scenes(@Param("id", ParseUUIDPipe) id: string) {
    await this.pipeline.getProject(id);
    const scenes = await this.ctx.ds.getRepository(Scene).find({ where: { projectId: id }, order: { idx: "ASC" } });
    const segs = await this.ctx.ds.getRepository(Asset).find({ where: { projectId: id, type: "segment" } });
    const staleBySeg = new Map(segs.map((a) => [a.sceneId, a.stale]));
    return scenes.map((s) => ({
      id: s.id, idx: s.idx, beat: s.beat, narration: s.narration, visual: s.visual, characters: s.characters, imageText: s.imageText ?? [], lighting: s.lighting, shot: s.shot, camera: s.camera, motion: s.motion,
      transitionOut: s.transitionOut, onScreenText: s.onScreenText, approved: s.approved, status: s.status, error: s.error, errors: s.errors,
      audioDurationSec: s.audioDurationSec, audioUrl: assetUrl(s.audioAssetId), imageUrl: assetUrl(s.imageAssetId), clipUrl: assetUrl(s.clipAssetId),
      stale: staleBySeg.get(s.id) ?? false,
    }));
  }

  @Post("projects/:id/refs")
  refs(@Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.regenerateRefs(id);
  }

  @Get("projects/:id/refs")
  async listRefs(@Param("id", ParseUUIDPipe) id: string) {
    const p = await this.pipeline.getProject(id);
    const refs = await this.ctx.assets.list(id, "ref");
    return {
      characterSheets: refs.filter((a) => a.params.role === "character_sheet").map((a) => ({ id: a.id, url: assetUrl(a.id), uploaded: a.params.uploaded === true, global: a.params.global === true, selected: a.id === p.characterSheetAssetId })),
      modernSheets: refs.filter((a) => a.params.role === "character_sheet_modern" || a.params.role === "character_sheet_modern_draft").map((a) => ({ id: a.id, url: assetUrl(a.id), draft: a.params.role === "character_sheet_modern_draft", global: a.params.global === true, selected: a.id === p.meta.characterSheetModernAssetId })),
      lockVersion: p.meta.characterLockVersion ?? null,
      anchors: refs.filter((a) => a.params.role === "anchor").map((a) => ({ id: a.id, url: assetUrl(a.id), selected: a.id === p.styleAnchorAssetId, global: a.params.global === true })),
    };
  }

  @Post("projects/:id/refs/select")
  selectRefs(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(SelectRefsDto)) dto: z.infer<typeof SelectRefsDto>) {
    return this.pipeline.selectRefs(id, dto);
  }

  @Post("projects/:id/refs/character-sheet")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } }))
  async uploadSheet(@Param("id", ParseUUIDPipe) id: string, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.mimetype)) throw new BadRequestException("upload a PNG, JPEG or WebP image as `file`");
    const a = await this.pipeline.uploadCharacterSheet(id, file.buffer);
    return { id: a.id, url: assetUrl(a.id) };
  }

  private stageEndpoint(id: string, stage: "voice" | "image" | "clip", dto: { sceneIds?: string[] }) {
    return this.pipeline.enqueueStage(id, stage, { sceneIds: dto.sceneIds });
  }

  @Post("projects/:id/voice")
  voice(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(StageSceneIdsDto)) dto: { sceneIds?: string[] }) {
    return this.stageEndpoint(id, "voice", dto);
  }
  @Post("projects/:id/images")
  images(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(StageSceneIdsDto)) dto: { sceneIds?: string[] }) {
    return this.stageEndpoint(id, "image", dto);
  }
  @Post("projects/:id/motion")
  motion(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(StageSceneIdsDto)) dto: { sceneIds?: string[] }) {
    return this.stageEndpoint(id, "clip", dto);
  }

  @Get("projects/:id/estimate")
  estimate(@Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.estimate(id);
  }

  @Post("projects/:id/run")
  async run(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(RunDto)) dto: RunDto) {
    return this.view(await this.pipeline.run(id, dto.to));
  }

  @Post("projects/:id/retry")
  retry(@Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.retry(id);
  }

  @Post("projects/:id/approve/:gate")
  async approve(@Param("id", ParseUUIDPipe) id: string, @Param("gate") gate: string) {
    if (!(GATES as readonly string[]).includes(gate)) throw new BadRequestException(`unknown gate "${gate}"`);
    return this.view(await this.pipeline.approve(id, gate as Gate));
  }

  @Post("projects/:id/render")
  render(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(RenderDto)) dto: RenderDto) {
    return this.pipeline.enqueueStage(id, dto.mode === "draft" ? "render_draft" : "render_final");
  }

  @Post("projects/:id/thumbnails")
  async thumbnails(@Param("id", ParseUUIDPipe) id: string) {
    const p = await this.pipeline.getProject(id);
    await this.ctx.ds.getRepository(Project).update(id, { meta: { ...p.meta, thumbGen: (p.meta.thumbGen ?? 0) + 1 } });
    return this.pipeline.enqueueStage(id, "thumb");
  }

  @Post("projects/:id/metadata")
  metadata(@Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.enqueueStage(id, "metadata");
  }

  @Get("projects/:id/jobs")
  async jobs(@Param("id", ParseUUIDPipe) id: string) {
    await this.pipeline.getProject(id);
    return this.ctx.ds.getRepository(Job).find({ where: { projectId: id }, order: { createdAt: "DESC" }, take: 200 });
  }

  @Get("projects/:id/outputs")
  async outputs(@Param("id", ParseUUIDPipe) id: string) {
    await this.pipeline.getProject(id);
    const keep = ["video", "srt", "ass", "thumbnail", "doc"] as const;
    const assets = await this.ctx.ds.getRepository(Asset).find({ where: { projectId: id, type: In([...keep]) }, order: { createdAt: "ASC" } });
    return assets.map((a) => ({
      id: a.id, type: a.type, kind: a.params.kind ?? a.params.mode ?? a.params.variant ?? null, stale: a.stale, bytes: a.bytes,
      name: a.storageKey.split("/").pop(), url: assetUrl(a.id), params: a.type === "thumbnail" || a.type === "video" ? a.params : undefined,
    }));
  }

  @Sse("projects/:id/events")
  events(@Param("id", ParseUUIDPipe) id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let unsubscribe: (() => Promise<void>) | undefined;
      let closed = false;
      const ping = setInterval(() => sub.next({ type: "ping", data: {} }), 15_000);
      this.ctx.events
        .subscribe(id, (ev) => sub.next({ type: ev.type, data: ev }))
        .then((u) => {
          if (closed) void u();
          else unsubscribe = u;
        })
        .catch((e) => sub.error(e));
      return () => {
        closed = true;
        clearInterval(ping);
        void unsubscribe?.();
      };
    });
  }
}
