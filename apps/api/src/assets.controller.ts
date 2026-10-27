import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type { Ctx } from "@vp/server";
import { CTX } from "./common";

const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

@Controller("assets")
export class AssetsController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  /**
   * Streams an asset by id (never by a user-supplied path). Express' sendFile
   * handles HTTP Range, so the preview player can seek (spec 3.4).
   */
  @Get(":id/content")
  async content(@Param("id", ParseUUIDPipe) id: string, @Query("download") download: string | undefined, @Res() res: Response) {
    const asset = await this.ctx.assets.get(id);
    if (!asset || !(await this.ctx.storage.exists(asset.storageKey))) throw new NotFoundException("asset not found");
    const file = this.ctx.storage.resolve(asset.storageKey);
    if (download) {
      const base = asset.storageKey.split("/").pop() ?? "download";
      res.setHeader("Content-Disposition", `attachment; filename="${base.replace(SAFE_NAME, "_")}"`);
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(asset.mime ?? "application/octet-stream");
    res.sendFile(file, { acceptRanges: true, lastModified: true, etag: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}
