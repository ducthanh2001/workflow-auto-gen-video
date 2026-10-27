/**
 * The global hero: one approved character sheet shared by every project (Character Style Lock v2).
 * Files live in DATA_DIR/global (a Docker volume, so they survive rebuilds); ASSETS_DIR/global is a
 * read-only fallback for sheets committed with the code.
 *   hero_sheet.png          the ancient-outfit sheet (reference number 1 on every call with a character)
 *   hero_sheet_modern.png   the modern-outfit sheet (shirt, hoodie, jacket, suit)
 *   hero_reference.png      a clean frame of the hero from a published video, used to draw a NEW sheet
 *   style_anchor.png        the style sample: one finished scene (hero + background) every scene copies the painting style of
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AppConfig } from "./config";

export const GLOBAL_KINDS = ["sheet", "modern", "reference", "anchor"] as const;
export type GlobalKind = (typeof GLOBAL_KINDS)[number];

const FILE: Record<GlobalKind, string> = { sheet: "hero_sheet.png", modern: "hero_sheet_modern.png", reference: "hero_reference.png", anchor: "style_anchor.png" };

const dirs = (cfg: Pick<AppConfig, "dataDir" | "assetsDir">) => [path.join(cfg.dataDir, "global"), path.join(cfg.assetsDir, "global")];

export interface GlobalFile {
  data: Buffer;
  /** short content hash, used to notice that a project's copy is out of date */
  hash: string;
}

export async function readGlobal(cfg: Pick<AppConfig, "dataDir" | "assetsDir">, kind: GlobalKind): Promise<GlobalFile | null> {
  for (const d of dirs(cfg)) {
    try {
      const data = await fs.readFile(path.join(d, FILE[kind]));
      return { data, hash: createHash("sha256").update(data).digest("hex").slice(0, 16) };
    } catch {
      /* try the next folder */
    }
  }
  return null;
}

export async function globalStatus(cfg: Pick<AppConfig, "dataDir" | "assetsDir">): Promise<Record<GlobalKind, boolean>> {
  const found = await Promise.all(GLOBAL_KINDS.map((k) => readGlobal(cfg, k)));
  return Object.fromEntries(GLOBAL_KINDS.map((k, i) => [k, !!found[i]])) as Record<GlobalKind, boolean>;
}

/** Validate the picture and store it as the global file for `kind` (replacing the old one). */
export async function saveGlobal(cfg: Pick<AppConfig, "dataDir" | "assetsDir">, kind: GlobalKind, input: Buffer): Promise<GlobalFile> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new Error("not a valid image");
  }
  if (!meta.width || !meta.height || meta.width < 512 || meta.height < 256) throw new Error("the image is too small (min 512x256)");
  const png = await sharp(input).rotate().resize(1920, 1080, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const dir = dirs(cfg)[0];
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, FILE[kind]), png);
  return { data: png, hash: createHash("sha256").update(png).digest("hex").slice(0, 16) };
}
