import type { SceneDraft } from "@vp/shared";

const SENTENCES = [
  "At three twelve on a quiet afternoon, a heart stops beating in a small hospital room.",
  "For the person lying there, the world does not go dark all at once, it fades in stages.",
  "Doctors use two standards to say that a person has died, and they are not the same thing.",
  "The first is the end of breathing and circulation, which can be seen and measured at the bedside.",
  "The second is the end of all brain function, which needs careful tests before anyone declares it.",
  "Within seconds of the heart stopping, oxygen runs out in the brain and consciousness slips away.",
  "Yet the cells of the body do not die together, and some keep working for hours afterward.",
  "Skin and bone can survive for a day, while neurons begin to fail within minutes.",
  "Researchers have studied these stages for decades, using careful observation and patient records.",
  "What they found surprised many, because death turns out to be a process rather than a moment.",
];

export function makeScript(opts: { sources?: boolean; beats?: number } = {}): string {
  const beats = opts.beats ?? 3;
  const fm = [
    "---",
    "title: What Happens in the First 24 Hours After You Die?",
    "language: en",
    "voice: narrator_calm",
    "style: warm-ink-cartoon",
    "target_minutes: 2",
    ...(opts.sources === false ? [] : ["sources:", "  - https://example.org/paper-1"]),
    "---",
    "",
  ].join("\n");
  const names = ["Hook", 'What "dead" means', "The slow shutdown", "Aftermath"];
  const body: string[] = [];
  for (let b = 0; b < beats; b++) {
    body.push(`## ${names[b % names.length]}`);
    body.push(SENTENCES.slice(b * 3, b * 3 + 4).concat(SENTENCES.slice(0, 3)).join(" "));
    body.push("");
  }
  return fm + body.join("\n");
}

/** Cut a narration string into scenes of about `words` words. */
export function sliceScenes(narrationByBeat: Array<{ beat: string; text: string }>, words = 16): SceneDraft[] {
  const scenes: SceneDraft[] = [];
  for (const b of narrationByBeat) {
    const w = b.text.split(/\s+/);
    for (let i = 0; i < w.length; i += words) {
      scenes.push({
        beat: b.beat,
        narration: w.slice(i, i + words).join(" "),
        visual: "A small round-headed figure sits beside a glowing candle in a dark blue room",
        shot: (["wide", "medium", "close", "detail"] as const)[scenes.length % 4],
        camera: scenes.length % 2 ? "pull_out" : "push_in",
        motion: "kenburns",
        transitionOut: "fade",
        onScreenText: null,
        characters: [{ role: "hero", props: "sitting beside a candle", expression: "calm" }],
        imageText: [],
      });
    }
  }
  return scenes;
}
