/**
 * Mock providers (spec 17): deterministic, free, offline. Used by tests, the API
 * e2e, and `PROVIDERS=mock` for trying the UI without spending money.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SceneDraft } from "@vp/shared";
import type { LlmClient } from "../planner";
import { THUMB_CONCEPT_MARKER } from "../thumbnail";
import { METADATA_MARKER } from "../metadata";
import { bins } from "../render/exec";
import type { ClipRequest, ClipResult, ImageProvider, ImageRequest, ImageResult, TtsProvider, TtsRequest, TtsResult, VideoProvider } from "./types";

const execFileP = promisify(execFile);

function hueOf(s: string): number {
  return createHash("sha1").update(s).digest().readUInt16BE(0) % 360;
}

/** Sine "voice": duration is proportional to the word count (about 190 wpm). */
export class MockTts implements TtsProvider {
  readonly id = "mock-tts";
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const words = req.text.trim().split(/\s+/).length;
    const sec = Math.max(0.8, (words / 190) * 60);
    const rate = 24000;
    const n = Math.round(sec * rate);
    const data = Buffer.alloc(44 + n * 2);
    data.write("RIFF", 0);
    data.writeUInt32LE(36 + n * 2, 4);
    data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(rate, 24);
    data.writeUInt32LE(rate * 2, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write("data", 36);
    data.writeUInt32LE(n * 2, 40);
    const f = 180 + (hueOf(req.text) % 120);
    for (let i = 0; i < n; i++) {
      // gentle syllable-like amplitude modulation so it is not a flat tone
      const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / rate);
      data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * f * i) / rate) * 9000 * env), 44 + i * 2);
    }
    return { audio: data, mime: "audio/wav", costUsd: 0 };
  }
}

export class MockImage implements ImageProvider {
  readonly id = "mock-image";
  readonly model = "mock";
  async generate(req: ImageRequest): Promise<ImageResult> {
    const h = hueOf(req.prompt);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},55%,28%)"/><stop offset="1" stop-color="hsl(${(h + 50) % 360},60%,45%)"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/>
<circle cx="${300 + (h % 600)}" cy="${250 + (h % 160)}" r="${90 + (h % 50)}" fill="hsl(${(h + 180) % 360},70%,70%)" stroke="#111" stroke-width="8"/>
<rect x="${100 + (h % 300)}" y="520" width="${300 + (h % 400)}" height="120" fill="hsl(${(h + 90) % 360},40%,20%)"/></svg>`;
    return { image: await sharp(Buffer.from(svg)).png().toBuffer(), mime: "image/png", costUsd: 0 };
  }
}

/** Needs ffmpeg: renders a short moving test clip. */
export class MockVideo implements VideoProvider {
  readonly id = "mock-video";
  readonly model = "mock";
  async generate(req: ClipRequest): Promise<ClipResult> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-mockclip-"));
    const inFile = path.join(dir, "in.png");
    const out = path.join(dir, "out.mp4");
    try {
      await fs.writeFile(inFile, req.image);
      await execFileP(bins.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", inFile, "-t", String(Math.min(req.seconds, 3)),
        "-vf", "scale=1280:720,zoompan=z='1+0.1*on/60':d=90:s=1280x720:fps=30,format=yuv420p", "-c:v", "libx264", "-an", out,
      ]);
      return { video: await fs.readFile(out), costUsd: 0, seconds: Math.min(req.seconds, 3) };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

/** Deterministic stand-in for the LLM: understands the planner, thumbnail and metadata prompts. */
export class MockLlm implements LlmClient {
  async complete(input: { system: string; user: string }) {
    if (input.system.includes(THUMB_CONCEPT_MARKER)) {
      return {
        costUsd: 0,
        text: JSON.stringify({
          concepts: [
            { name: "Candle", background: "A single glowing candle on a dark blue table, large empty space on the right", text: "The last hour" },
            { name: "Clock", background: "A stopped round clock on a wall in warm lamp light, empty dark space on the left", text: "What happens next" },
            { name: "Doorway", background: "A small round-headed figure at an open doorway of blue light, empty space on the right", text: "Beyond the door" },
          ],
        }),
      };
    }
    if (input.system.includes(METADATA_MARKER)) {
      return {
        costUsd: 0,
        text: JSON.stringify({
          titleAlternatives: ["The Science of the Final Hours", "What Really Happens When the Heart Stops"],
          hookLines: ["A heart stops, and a long chain of events begins.", "Here is what researchers have learned about it."],
          tags: ["science", "biology", "medicine", "explained", "education", "research", "human body", "documentary"],
        }),
      };
    }
    return { costUsd: 0, text: JSON.stringify({ scenes: mockPlan(input.user) }) };
  }
}

const SHOTS = ["wide", "medium", "close", "detail"] as const;
const CAMS = ["push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down"] as const;
const VISUALS = [
  "A small round-headed figure sits beside a glowing candle in a dark blue room",
  "A wooden clock on a stone wall with warm lamp light and deep blue shadows",
  "A quiet hospital window at dusk, orange light against a deep blue sky",
  "Two simple figures walk along a lantern-lit path through a painted forest",
  "A stack of old books and a lamp on a desk beside a rainy window",
];

/** Greedy sentence packing into scenes of about 12 to 20 words, keyed by "## beat" headings. */
export function mockPlan(userPrompt: string): SceneDraft[] {
  const script = userPrompt.split("SCRIPT:\n")[1] ?? userPrompt;
  const scenes: SceneDraft[] = [];
  let beat = "Intro";
  let paragraphs: string[] = [];
  const flush = () => {
    const sentences = paragraphs.join(" ").match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
    let cur: string[] = [];
    let words = 0;
    const emit = () => {
      if (!cur.length) return;
      const i = scenes.length;
      scenes.push({
        beat,
        narration: cur.join(" "),
        visual: VISUALS[i % VISUALS.length],
        shot: SHOTS[i % SHOTS.length],
        camera: CAMS[i % CAMS.length],
        motion: i % 9 === 4 ? "ai_clip" : "kenburns",
        transitionOut: "fade",
        onScreenText: null,
        // the 2nd and 4th visuals show no person
        characters: i % VISUALS.length === 1 || i % VISUALS.length === 4 ? [] : [{ role: "hero", expression: "calm" }],
        imageText: [],
        lighting: "golden_hour",
      });
      cur = [];
      words = 0;
    };
    for (const s of sentences) {
      const w = s.split(/\s+/).length;
      if (words && words + w > 20) emit();
      cur.push(s);
      words += w;
      if (words >= 12) emit();
    }
    emit();
    paragraphs = [];
  };
  for (const line of script.split("\n")) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      flush();
      beat = h[1].trim();
    } else if (line.trim()) paragraphs.push(line.trim());
  }
  flush();
  return scenes;
}
