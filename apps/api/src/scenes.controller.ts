import {
  BadRequestException, Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { UpdateSceneDto } from "@vp/shared";
import type { Pipeline } from "@vp/server";
import { PIPELINE, ZodPipe } from "./common";

@Controller("scenes")
export class ScenesController {
  constructor(@Inject(PIPELINE) private readonly pipeline: Pipeline) {}

  /** `narration` is not part of UpdateSceneDto, and the schema is strict, so sending it is a 400. */
  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateSceneDto)) dto: UpdateSceneDto) {
    return this.pipeline.updateScene(id, dto);
  }

  @Post(":id/regenerate/:stage")
  regenerate(@Param("id", ParseUUIDPipe) id: string, @Param("stage") stage: string) {
    if (stage !== "voice" && stage !== "image" && stage !== "clip") {
      throw new BadRequestException("stage must be voice, image or clip");
    }
    return this.pipeline.regenerateScene(id, stage);
  }

  /** The prompt and references an image call for this scene would use. Read-only, costs nothing. */
  @Get(":id/prompt")
  prompt(@Param("id", ParseUUIDPipe) id: string) {
    return this.pipeline.scenePrompt(id);
  }

  /** Use your own picture for this scene (e.g. when generation failed or credits ran out). */
  @Post(":id/image/upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024 } }))
  async uploadImage(@Param("id", ParseUUIDPipe) id: string, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.mimetype)) throw new BadRequestException("upload a PNG, JPEG or WebP image as `file`");
    const a = await this.pipeline.uploadSceneImage(id, file.buffer);
    return { id: a.id, url: `/assets/${a.id}/content` };
  }
}
