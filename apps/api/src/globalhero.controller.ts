import {
  BadRequestException, Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { z } from "zod";
import { GLOBAL_KINDS, Project, applyGlobalHero, generateModernSheet, globalStatus, readGlobal, saveGlobal, type Ctx, type GlobalKind } from "@vp/server";
import { CHARACTER_LOCK_VERSION } from "@vp/shared";
import { CTX, ZodPipe } from "./common";

const SaveDto = z.object({ kind: z.enum(GLOBAL_KINDS), assetId: z.string().uuid().optional() });

/**
 * The global hero (Character Style Lock v2): one approved sheet for every project. These calls change the hero for
 * EVERY project created from now on; a project that already has references keeps its own copy until it refreshes them.
 */
@Controller()
export class GlobalHeroController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Get("global-hero")
  async status() {
    return { ...(await globalStatus(this.ctx.cfg)), lockVersion: CHARACTER_LOCK_VERSION };
  }

  /** Store a picture you upload as the global sheet, modern sheet, style sample (anchor) or the reference frame of the hero. */
  @Post("global-hero/:kind")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } }))
  async upload(@Param("kind") kind: string, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    if (!(GLOBAL_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`kind must be one of ${GLOBAL_KINDS.join(", ")}`);
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.mimetype)) throw new BadRequestException("upload a PNG, JPEG or WebP image as `file`");
    try {
      await saveGlobal(this.ctx.cfg, kind as GlobalKind, file.buffer);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return { ok: true, ...(await globalStatus(this.ctx.cfg)) };
  }

  /** Save a project's own sheet (or a generated modern sheet) as the global one. */
  @Post("projects/:id/refs/save-global")
  async saveFromProject(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(SaveDto)) dto: z.infer<typeof SaveDto>) {
    if (dto.kind === "reference") throw new BadRequestException("the reference frame is uploaded with POST /global-hero/reference");
    const p = await this.ctx.ds.getRepository(Project).findOneBy({ id });
    if (!p) throw new BadRequestException("project not found");
    const assetId = dto.assetId ?? (dto.kind === "sheet" ? p.characterSheetAssetId : dto.kind === "anchor" ? p.styleAnchorAssetId : p.meta.characterSheetModernAssetId) ?? undefined;
    if (!assetId) throw new BadRequestException("no sheet to save: pass assetId");
    const asset = await this.ctx.assets.get(assetId);
    const role = String(asset?.params.role ?? "");
    const okRole = dto.kind === "anchor" ? role === "anchor" : role.startsWith("character_sheet");
    if (!asset || asset.projectId !== id || asset.type !== "ref" || !okRole) {
      throw new BadRequestException(dto.kind === "anchor" ? "that asset is not a style sample of this project" : "that asset is not a character sheet of this project");
    }
    await saveGlobal(this.ctx.cfg, dto.kind, await this.ctx.storage.read(asset.storageKey));
    return { ok: true, ...(await globalStatus(this.ctx.cfg)) };
  }

  /** Swap this project's hero for the saved global one right now (free, nothing is drawn). */
  @Post("projects/:id/refs/use-global")
  async useGlobal(@Param("id", ParseUUIDPipe) id: string) {
    try {
      return await applyGlobalHero(this.ctx, id);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Draw the modern-outfit sheet (one image) from this project's hero sheet. */
  @Post("projects/:id/refs/modern-sheet")
  async modern(@Param("id", ParseUUIDPipe) id: string) {
    try {
      const a = await generateModernSheet(this.ctx, id);
      return { id: a.id, url: `/assets/${a.id}/content` };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Get("global-hero/:kind")
  async preview(@Param("kind") kind: string) {
    if (!(GLOBAL_KINDS as readonly string[]).includes(kind)) throw new BadRequestException("unknown kind");
    const g = await readGlobal(this.ctx.cfg, kind as GlobalKind);
    return { exists: !!g, hash: g?.hash ?? null };
  }
}
