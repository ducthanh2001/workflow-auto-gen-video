import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { parseStyle } from "../src/style";
import { bins, probe, runFfmpeg, runFfmpegStdout, renderClipSegment, renderStillSegment } from "../src/render";
import { cleanOverlayText, renderTextOverlay } from "../src/render/overlay";

const FONT = path.resolve(__dirname, "../../../assets/fonts/Anton-Regular.ttf");
const FPS = 30;
const ENC = { width: 640, height: 360, fps: FPS, crf: 23, preset: "ultrafast" };

function hasFfmpeg() {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** bright pixels in the top-left quarter of the frame at time t */
async function whiteTopLeft(video: string, t: number): Promise<number> {
  const W = 320, H = 180;
  const buf = await runFfmpegStdout(["-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  let n = 0;
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) {
    const o = (y * W + x) * 3;
    if (buf[o] > 225 && buf[o + 1] > 225 && buf[o + 2] > 225) n++;
  }
  return n;
}

describe("on-screen text", () => {
  it("cleans control characters and caps at 40 characters", () => {
    expect(cleanOverlayText("  a\u0000b\n c  ")).toBe("a b c");
    expect(cleanOverlayText("x".repeat(90))).toHaveLength(40);
  });

  it("renders a transparent PNG with the label", async () => {
    const png = await renderTextOverlay({ text: "Hour one", fontPath: FONT, width: 640, height: 360 });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    let opaque = 0, white = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200) opaque++;
      if (data[i] > 240 && data[i + 3] > 240) white++;
    }
    expect(opaque).toBeGreaterThan(200);
    expect(white).toBeGreaterThan(100);
    expect(data[3]).toBe(0); // the corner is transparent
  });
});

describe.skipIf(!hasFfmpeg())("on-screen text in segments", () => {
  let dir: string;
  let style: ReturnType<typeof parseStyle>;
  let image: string;
  let overlay: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-overlay-"));
    style = parseStyle(await fs.readFile(path.resolve(__dirname, "../../../config/styles/warm-ink-cartoon.yaml"), "utf8"));
    image = path.join(dir, "bg.png");
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 20, g: 40, b: 90 } } }).png().toFile(image);
    overlay = path.join(dir, "text.png");
    await fs.writeFile(overlay, await renderTextOverlay({ text: "Hour one", fontPath: FONT, width: ENC.width, height: ENC.height }));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fades the label in and out over a still segment", async () => {
    const out = path.join(dir, "still.mp4");
    const frames = 5 * FPS;
    await renderStillSegment({ out, frames, camera: "push_in", imagePath: image, overlayPng: overlay }, { enc: ENC, cameraDefaults: style.camera_defaults, prescaleWidth: 1280 });
    const info = await probe(out);
    expect(info.video!.width).toBe(640);
    expect(Math.round(info.video!.durationSec * FPS)).toBe(frames);
    expect(await whiteTopLeft(out, 0.0)).toBe(0); // not yet visible
    expect(await whiteTopLeft(out, 2.0)).toBeGreaterThan(30); // fully visible
    expect(await whiteTopLeft(out, 4.9)).toBe(0); // faded out
  });

  it("also works over an AI clip segment", async () => {
    const clip = path.join(dir, "clip.mp4");
    await runFfmpeg(["-f", "lavfi", "-i", "color=c=0x203060:s=320x180:d=2:r=24", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    const out = path.join(dir, "clipseg.mp4");
    await renderClipSegment({ out, frames: 4 * FPS, camera: "static", imagePath: image, clipPath: clip, overlayPng: overlay }, { enc: ENC, cameraDefaults: style.camera_defaults });
    expect(Math.round((await probe(out)).video!.durationSec * FPS)).toBe(4 * FPS);
    expect(await whiteTopLeft(out, 2.0)).toBeGreaterThan(30);
  });

  it("without a label nothing is drawn", async () => {
    const out = path.join(dir, "plain.mp4");
    await renderStillSegment({ out, frames: 3 * FPS, camera: "static", imagePath: image }, { enc: ENC, cameraDefaults: style.camera_defaults, prescaleWidth: 1280 });
    expect(await whiteTopLeft(out, 1.5)).toBe(0);
  });
});
