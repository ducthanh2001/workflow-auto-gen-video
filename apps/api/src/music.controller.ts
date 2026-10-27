import {
  BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { probe, requireLicenseNote } from "@vp/core";
import { MusicTrack, Project, type Ctx } from "@vp/server";
import { CTX } from "./common";

const MAX_BYTES = 50 * 1024 * 1024;

/** Looks like WAV (RIFF....WAVE) or MP3 (ID3 tag or MPEG frame sync). */
function sniffAudio(b: Buffer): "wav" | "mp3" | null {
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (b.length > 3 && b.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";
  return null;
}

@Controller("music")
export class MusicController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Get()
  async list() {
    const rows = await this.ctx.ds.getRepository(MusicTrack).find({ order: { createdAt: "DESC" } });
    return rows.map((t) => ({ id: t.id, name: t.name, durationSec: t.durationSec, licenseNote: t.licenseNote, createdAt: t.createdAt }));
  }

  /** The licence note is mandatory; the app never downloads or generates music (spec 9.3). */
  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES } }))
  async create(@Body() body: { name?: string; licenseNote?: string }, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    if (!file) throw new BadRequestException("send an audio file as `file`");
    let note: string;
    try {
      note = requireLicenseNote(body?.licenseNote);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".mp3" && ext !== ".wav") throw new BadRequestException("only .mp3 and .wav files are accepted");
    const kind = sniffAudio(file.buffer);
    if (!kind || (kind === "wav") !== (ext === ".wav")) throw new BadRequestException("the file content does not match its extension");

    // ffprobe must see a real audio stream before we accept it
    const tmp = path.join(os.tmpdir(), `vp-music-${randomUUID()}${ext}`);
    await fs.writeFile(tmp, file.buffer);
    let durationSec = 0;
    try {
      const info = await probe(tmp);
      if (!info.audio) throw new Error("no audio stream");
      durationSec = info.audio.durationSec || info.durationSec;
    } catch {
      throw new BadRequestException("ffprobe could not read this file as audio");
    } finally {
      await fs.rm(tmp, { force: true });
    }
    if (durationSec < 10) throw new BadRequestException("the track must be at least 10 seconds long");

    const id = randomUUID();
    const storageKey = `music/${id}${ext}`;
    await this.ctx.storage.put(storageKey, file.buffer);
    const repo = this.ctx.ds.getRepository(MusicTrack);
    const track = await repo.save(
      repo.create({ id, name: (body.name?.trim() || path.basename(file.originalname, ext)).slice(0, 200), storageKey, durationSec, licenseNote: note }),
    );
    return { id: track.id, name: track.name, durationSec: track.durationSec, licenseNote: track.licenseNote };
  }

  @Delete(":id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    const repo = this.ctx.ds.getRepository(MusicTrack);
    const t = await repo.findOneBy({ id });
    if (!t) throw new NotFoundException("track not found");
    const inUse = (await this.ctx.ds.getRepository(Project).find()).filter((p) => p.settings.musicTrackId === id);
    for (const p of inUse) await this.ctx.ds.getRepository(Project).update(p.id, { settings: { ...p.settings, musicTrackId: null } });
    await repo.delete({ id });
    await this.ctx.storage.remove(t.storageKey).catch(() => undefined);
    return { ok: true, detachedFrom: inUse.length };
  }
}
