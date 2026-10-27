# Script-to-Video Studio: Build Spec

> **Tóm tắt (Vietnamese):** Đây là tài liệu đặc tả để đưa vào VS Code cho AI coding agent xây sản phẩm: đưa vào một kịch bản tiếng Anh, sản phẩm tự chia cảnh, tạo giọng đọc, tạo ảnh theo một phong cách cố định, tạo chuyển động, ghép khớp tiếng với hình bằng ffmpeg với chuyển cảnh mượt, tạo thumbnail nổi bật và metadata để đăng YouTube. Làm theo hai giai đoạn: CLI chạy bằng file trước (Phase 1), giao diện duyệt web sau (Phase 2).

---

## 1. Goal and non-goals

**Goal.** Input: one script file. Output: a finished 1920x1080 MP4 whose narration is perfectly aligned with the visuals, plus 3 thumbnail variants, an SRT caption file and a YouTube metadata file (title options, description with chapters, sources).

**Non-goals (v1).**
- No automatic upload to YouTube (the user uploads manually; optional later via YouTube Data API).
- No face-on-camera avatars, no real people, no voice cloning of real people.
- No live editing timeline UI. A review grid is enough.

**Originality rule (important).** The visual style is a *generic* look: simple round-headed cartoon people on a more detailed painted background, warm/cool lighting contrast. The product must ship with its own original characters and its own thumbnail design language. It must NOT reproduce any existing channel's characters, logo, name or thumbnails, and the style preset must never contain a channel name.

---

## 2. Inputs and outputs

### 2.1 Script format (`script.md`)

```markdown
---
title: What Happens in the First 24 Hours After You Die?
language: en
voice: narrator_calm        # key in config/voices.json
style: warm-ink-cartoon     # key in config/styles/*.yaml
target_minutes: 10
sources:
  - https://example.org/paper-1
  - https://example.org/paper-2
---

## Hook
At 3:12 on a quiet afternoon, a heart stops. For the person lying there, ...

## What "dead" means
Doctors use two standards ...
```

Rules:
- `##` headings are **beats**. They become YouTube chapters and may force a stronger transition. Heading text is never narrated.
- Everything else is narration, in order. The pipeline must never rewrite, reorder, add or drop narration words (see 5.2 verbatim check).

### 2.2 Outputs (`projects/<slug>/out/`)

| File | Description |
|---|---|
| `final.mp4` | 1920x1080, 30 fps, H.264 `yuv420p`, AAC 48 kHz, `+faststart`, loudness about -14 LUFS |
| `draft.mp4` | 960x540 fast preview of the same timeline |
| `captions.en.srt` | Sentence-level captions generated from the real scene timings |
| `thumbnail_A.jpg`, `_B`, `_C` | 1280x720 JPG, each under 2 MB (verify YouTube's current limit) |
| `metadata.md` | Title options, description with chapters, sources, AI-disclosure line, tags |
| `report.json` | Per-stage cost, durations, retries, drift measurement |

---

## 3. Architecture and tech stack

The developer's stack is TypeScript (NestJS, Next.js, PostgreSQL). Build in two phases so something works end to end quickly.

**Phase 1: CLI + filesystem (no DB, no queue).**
- Node 20+, TypeScript, `zod` for schemas, `commander` for CLI, `p-limit` for concurrency, `execa` to call ffmpeg/ffprobe, `sharp` for image work.
- State lives in `projects/<slug>/` as JSON files and assets. Every stage is idempotent and resumable.

**Phase 2: web review UI + persistence.**
- Next.js review app (scene grid, regenerate buttons, draft preview player, thumbnail picker).
- NestJS API + PostgreSQL (TypeORM) + BullMQ/Redis workers. Same stage code as Phase 1, wrapped in jobs.

**Requirements.** `ffmpeg` and `ffprobe` (>= 6.0) on PATH, with `libx264`, `aac`, `zoompan`, `xfade`, `loudnorm` filters. Check on startup (`vp doctor`).

---

## 4. Project layout and data model

```
projects/<slug>/
  script.md
  project.json            # parsed front matter + settings snapshot
  scenes.json             # the scene plan (source of truth)
  audio/s001.wav ...      # per-scene narration
  images/s001_v1.png ...  # generated stills (versions)
  refs/character_sheet.png, style_anchor.png
  clips/s001.mp4 ...      # optional AI motion clips
  segments/s001.mp4 ...   # rendered per-scene video (no audio)
  chunks/chunk_01.mp4 ...
  out/ ...
  cache/<hash>.*          # provider response cache
```

### 4.1 Scene schema (`zod`)

```ts
const Scene = z.object({
  id: z.string(),                       // "s001"
  beat: z.string(),                     // heading text it belongs to
  narration: z.string().min(1),         // verbatim slice of the script
  visual: z.string().min(10),           // concrete description, no text in image
  shot: z.enum(["wide","medium","close","detail"]),
  camera: z.enum(["push_in","pull_out","pan_left","pan_right","tilt_up","tilt_down","static"]),
  motion: z.enum(["kenburns","ai_clip"]),
  transition_out: z.enum(["cut","fade","fadeblack","dissolve"]),
  on_screen_text: z.string().max(40).nullable(),
  // filled by later stages:
  audio: z.object({ path: z.string(), durationSec: z.number() }).optional(),
  image: z.object({ path: z.string(), version: z.number(), approved: z.boolean() }).optional(),
  clip: z.object({ path: z.string(), durationSec: z.number() }).optional(),
  slotSec: z.number().optional(),       // lead + audio + tail (see section 8)
});
```

Asset cache key = `sha256(provider + model + prompt + refsHash + params)`. If the file exists, skip the call.

---

## 5. Pipeline stages

Each stage is a pure function over `scenes.json` + assets, can be re-run for a single scene (`--scene s017`), and logs cost.

### 5.1 Parse
Parse front matter (`gray-matter`), split into beats and paragraphs, normalize whitespace and quotes. Reject scripts with no `##` heading (warn) or under 100 words.

### 5.2 Scene planning (LLM)
Call the Anthropic API (model string `claude-sonnet-5-5`) with the script and the planning prompt below. Output must validate against the `Scene[]` schema.

**Planning rules to give the model:**
1. Split narration into scenes of **12 to 20 words** (about 4 to 8 seconds at ~190 words per minute). Prefer sentence boundaries; never split mid-sentence unless the sentence is over 30 words.
2. Narration fields are **exact slices** of the script. Do not paraphrase, fix grammar, add or remove words.
3. `visual` must be concrete, show one clear idea, and contain **no text, letters, numbers or logos** and **no real, named people**.
4. Vary `shot` and `camera`; alternate `push_in` and `pull_out`; avoid more than 3 identical shots in a row.
5. `motion: "ai_clip"` for at most 15% of scenes, only where movement carries meaning (fire, rain, water, crowd, clock hands). Everything else `kenburns`.
6. `transition_out`: `fade` by default; `fadeblack` at the last scene of a beat; `cut` between two scenes that continue the same moment.
7. Sensitive-topic rule: no gore, no graphic bodies, no depiction of self-harm or method of death. Use symbols (clock, hands, candle, stylized figures).

**Verbatim check (hard gate).** After the LLM returns, normalize (lowercase, strip punctuation and whitespace) and assert `concat(scene.narration) === concat(script narration)`. On mismatch, retry up to 2 times with the diff in the prompt, then fail loudly. This protects the research text from silent LLM edits.

### 5.3 Voice (TTS)
Provider interface (section 7). Default: ElevenLabs `POST /v1/text-to-speech/{voice_id}`.

- Generate **one audio file per scene**, WAV or high-bitrate MP3 converted to WAV 48 kHz mono.
- Pass neighboring text as context if the provider supports it (previous/next text) so prosody flows across scene boundaries.
- Measure true duration with `ffprobe` (never estimate from word count).
- Run a loudness-peak check; reject silent or clipped files and retry once.
- Improvement (v2): synthesize per paragraph, then cut scene boundaries using word timestamps from forced alignment (Whisper with word timestamps). Better prosody, same timeline math.

### 5.4 Images
For each scene build the prompt:

```
{style.prefix}
Characters: {style.characters}
Scene: {scene.visual}
Framing: {scene.shot} shot, 16:9.
{style.suffix}
Hard constraints: no text or letters in the image, no watermark, no real people.
```

- Pass up to 3 reference images: `refs/character_sheet.png`, `refs/style_anchor.png`, and (optional) the previous scene's image for continuity.
- Request 16:9 at the provider's largest supported size; then upscale/crop with `sharp` to **3840x2160** (needed to keep Ken Burns sharp).
- Generate 1 version by default; `--variants 2` for important scenes.
- **Bootstrapping consistency:** on first run generate the character sheet (3 poses on a plain background) and 4 candidate style anchors; the user picks one; both are saved to `refs/` and reused for the whole project.
- Auto-checks after generation: dimension, not-blank, and a lightweight text-detection pass (OCR); if text is detected, regenerate once with a stronger "no text" constraint.

### 5.5 Motion
- **Ken Burns (default).** Derived from `scene.camera` (see section 9.1).
- **AI clip (<= 15% of scenes).** Image-to-video provider (fal.ai: Kling 3.0 or Veo 3.1 Lite). Prompt = the scene's visual + one short motion instruction ("flames flicker, rain falls, camera holds"). Request a 5 second clip.
- If the clip is shorter than `slotSec + transition`, loop it ping-pong (`reverse` + concat) or slow it by up to 15%; if still short, hold the last frame. If longer, trim.
- Clip failed or artifacts detected (provider error, or frame difference too small/too large): fall back to Ken Burns for that scene and note it in `report.json`.

### 5.6 Timeline and render
Compute the timeline (section 8), render each scene to a segment (section 9.1), render chunks with `xfade` (9.2), build the audio track (9.3), mux, loudness-normalize, verify.

### 5.7 Captions
Write `captions.en.srt` from scene narration and slot start times (one cue per scene, wrap at ~42 characters, max 2 lines). Offer `--burn-captions` for an on-screen version.

### 5.8 Thumbnail
See section 10.

### 5.9 Metadata
See section 11.

---

## 6. Style system

Styles are YAML files in `config/styles/`. The default preset describes a generic look derived from a reference frame: simple cartoon figures with round heads on a richer painted environment.

```yaml
# config/styles/warm-ink-cartoon.yaml
name: warm-ink-cartoon
aspect: "16:9"
prefix: >
  2D flat cartoon illustration with thick dark outlines. Characters are simple:
  round heads, dot eyes, tiny mouth, thin stick limbs, simple garments.
  Backgrounds are richer and more painterly than the characters, with soft
  shading and detailed textures. Strong warm and cool light contrast
  (orange firelight against deep blue night). Limited, harmonious palette.
characters: >
  Use the attached character sheet exactly: same head shape, same face style,
  same proportions and line weight. Clothing may change per scene.
suffix: >
  Cinematic wide composition, clear focal point, uncluttered foreground,
  no text anywhere in the image.
palette_hint: ["#f28c28", "#1b2a49", "#7a5230", "#e9e2d0"]
camera_defaults:
  push_in:  { zoomStart: 1.00, zoomEnd: 1.10 }
  pull_out: { zoomStart: 1.10, zoomEnd: 1.00 }
  pan_left: { zoom: 1.08, xFrom: 0.55, xTo: 0.45 }
  pan_right:{ zoom: 1.08, xFrom: 0.45, xTo: 0.55 }
```

Make the character sheet your own: change head shape, hair/fur treatment, color accents and clothing marks so the look is distinct from other channels. Store the sheet in `refs/character_sheet.png` per project.

---

## 7. Provider interfaces and configuration

```ts
interface TtsProvider {
  name: string;
  synthesize(i: { text: string; voiceId: string; previousText?: string;
                  nextText?: string; outPath: string }): Promise<{ durationSec: number; costUsd: number }>;
}
interface ImageProvider {
  name: string;
  generate(i: { prompt: string; refs: string[]; aspect: "16:9"; outPath: string;
                seed?: number }): Promise<{ costUsd: number }>;
}
interface VideoProvider {
  name: string;
  imageToVideo(i: { imagePath: string; prompt: string; durationSec: number;
                    outPath: string }): Promise<{ durationSec: number; costUsd: number }>;
}
interface LlmProvider { planScenes(script: ParsedScript, style: Style): Promise<Scene[]>; }
```

Implementations to start with: `ElevenLabsTts`, `GeminiImage`, `FluxImage`, `FalVideo` (Kling 3.0, Veo 3.1 Lite), `AnthropicPlanner`. Each is selected by `config/providers.json`; swapping a provider must not touch pipeline code. Every provider call: timeout, exponential backoff (3 tries), cache, and cost recording.

`.env` (names illustrative; never log values):

```
ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=
GEMINI_API_KEY=
BFL_API_KEY=
FAL_KEY=
```

Voices live in `config/voices.json` (`{"narrator_calm": {"provider":"elevenlabs","voiceId":"..."}}`). Use only voices you have the right to use commercially.

---

## 8. Timeline and sync math (the core of "khớp")

Constants (configurable): `fps = 30`, `LEAD = 0.20 s`, `TAIL = 0.30 s`, `T = 0.40 s` (crossfade length; must satisfy `T <= LEAD + TAIL - 0.1`).

For scene *i* with measured audio duration `a_i`:

```
D_i = LEAD + a_i + TAIL          # the scene's slot on the timeline
A_i = sum_{j<i} D_j              # slot start (A_1 = 0)
```
At a paragraph/beat change add extra tail: `TAIL_beat = 0.60 s`.

**Video segments are rendered longer than their slot** so crossfades overlap the neighbor:

```
L_i = D_i + T   for i < n       (needs T of extra material to fade into the next scene)
L_n = D_n + T/2                 (last scene holds its final frame so the video is as long as the delayed narration)
```

With this, the chain of xfades yields a video of length `sum_i L_i - (n-1)*T = sum D_i + T/2`. Without the `T/2` hold the video would end `T/2` before the narration.

**xfade offsets** (chain of k = 1..n-1 joins, duration T):

```
offset_k = sum_{j<=k} L_j - k*T = sum_{j<=k} D_j = A_{k+1}
```
So each fade **starts exactly at the next slot's start** in the video timeline.

**Center the transition on the spoken boundary:** delay the whole narration track by `T/2`. Then the fade spans `[A_{k+1}, A_{k+1}+T]` in video time and is centered on the audio slot boundary `A_{k+1} + T/2`. With `LEAD=0.2`, `TAIL=0.3`, `T=0.4` the fade falls inside the silent window between sentences, so words are never covered by a transition.

**Hard cuts (`cut`)** use `T_k = 0` for that join: no extra tail on that segment, plain concat, offset unchanged.

**Total video length** = `sum D_i + T/2` (trim the final output with `-t`). Narration track length must equal the video length within 1 frame (33 ms).

**Invariants to unit-test:**
1. `offset_k` equals `A_{k+1}` for any mix of fade and cut joins.
2. `sum(D_i) + T/2` equals the measured audio length within 1 frame.
3. A scene's audio never overlaps a fade window.

---

## 9. ffmpeg recipes

### 9.1 Per-scene segment (Ken Burns)

Do **not** use `-loop 1` with `zoompan` (it multiplies frames). Feed the still once and let `zoompan` produce `frames` output frames. Pre-scale the still to 2x to 4x the output width to reduce zoompan jitter.

```bash
FRAMES=$(printf "%.0f" "$(echo "$L * 30" | bc -l)")
ffmpeg -y -i images/s001_v1.png \
  -vf "scale=3840:-2,zoompan=z='min(zoom+${STEP},${ZOOM_END})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${FRAMES}:s=1920x1080:fps=30,format=yuv420p" \
  -frames:v ${FRAMES} -c:v libx264 -crf 14 -preset medium -r 30 -an segments/s001.mp4
```

- `STEP = (zoomEnd - zoomStart) / FRAMES`. For `pull_out` start at `zoomStart` using `z='if(lte(on,1),${ZOOM_START},max(${ZOOM_END},zoom-${STEP}))'`.
- Pans: keep zoom constant and move `x` linearly from `xFrom` to `xTo` as a fraction of the available travel (`(iw-iw/zoom)`), e.g. `x='(iw-iw/zoom)*(xFrom+(xTo-xFrom)*on/FRAMES)'`.
- AI clips: `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p`, trimmed or looped to `L_i`.
- All segments **must share** resolution, fps, pixel format and timebase (`settb=AVTB`) or `xfade` fails.

### 9.2 Crossfades with xfade (chunked)

One filtergraph with 100+ inputs is slow and fragile. Render in **chunks of 10 to 15 scenes**, then join the chunks with the same formula (each chunk is a segment with `L = sum D + T`; only the last chunk ends with `+ T/2` instead).

```bash
ffmpeg -y -i s001.mp4 -i s002.mp4 -i s003.mp4 \
  -filter_complex "\
[0:v][1:v]xfade=transition=fade:duration=0.4:offset=OFFSET1[v1];\
[v1][2:v]xfade=transition=fade:duration=0.4:offset=OFFSET2[v2]" \
  -map "[v2]" -c:v libx264 -crf 14 -preset medium -pix_fmt yuv420p chunks/chunk_01.mp4
```

Offsets come from the timeline module (`offset_k = A_{k+1}` relative to the chunk start). `transition` values: `fade`, `fadeblack`, `dissolve`; for `cut` use a plain `concat` join instead. Keep intermediates high quality (CRF 12 to 14) because they are re-encoded once more.

### 9.3 Audio track

1. Pad each `audio/sNNN.wav` to its slot: `adelay=LEAD*1000` then `apad=whole_dur=D_i`.
2. Concatenate all padded files (concat demuxer, PCM, no re-encode).
3. Delay the whole track by `T/2`: `adelay=200|200`.
4. Optional music bed: loop a licensed track, lower it about 20 dB under narration, apply ducking `sidechaincompress` keyed by the narration.
5. Normalize: two-pass `loudnorm=I=-14:TP=-1.5:LRA=11`.

### 9.4 Final mux

```bash
ffmpeg -y -i video_all.mp4 -i narration_final.wav \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart -t ${TOTAL} out/final.mp4
```

Draft mode: same graph at 960x540, `-crf 28 -preset veryfast`, Ken Burns only (AI clips replaced by their still frame) so previews are cheap and fast.

---

## 10. Thumbnail generator

Goal: 3 distinct, high-contrast thumbnails per video, 1280x720.

1. **Concepts (LLM).** From title + script, propose 3 concepts. Rules: one focal subject, strong contrast, large negative space for text, **max 4 words** of text, curiosity-driven but truthful to the video, no gore, no real people, no copying of any existing channel's thumbnails.
2. **Background art (image model).** Generate the background **without any text**, using the project's style preset and character sheet.
3. **Text (code, not the image model).** Render text with `sharp` + SVG or `satori`: heavy sans-serif font (bundle an OFL-licensed font), white text with dark stroke/shadow, placed in the largest quiet region.
4. **Checks.** Text contrast ratio at least 7:1 against the sampled background, text occupies at most 35% of width, no important content in the bottom-right corner (YouTube's duration badge), readable at 168x94 px (downscale test).
5. **Output.** `thumbnail_A/B/C.jpg`, quality 90, under 2 MB. The review UI shows them side by side at full size and at tiny size.

---

## 11. Metadata (`metadata.md`)

- **3 title options** (the first is the script's title). Max 70 characters, curiosity gap, no clickbait that the video does not deliver.
- **Description**: first two lines are a hook; then chapters, sources, disclosure lines.
- **Chapters** from beats: first chapter at `0:00`, at least 3 chapters, each at least 10 seconds long (verify YouTube's current rules). Timestamp = `A_i` of the beat's first scene, formatted `m:ss`.
- **Sources**: the `sources:` list from front matter, one per line.
- **Disclosure lines**: "Educational content, not medical advice." and, when synthetic voice or imagery is used, an AI-assistance line. Remind the user to set YouTube's altered/synthetic-content disclosure in Studio if applicable.
- **Tags**: 8 to 12, from the title and beats.

---

## 12. CLI

```
vp doctor                         # check ffmpeg, fonts, env keys
vp init <slug> --script path.md   # create project
vp plan   <slug> [--replan]       # 5.2 scene plan (verbatim check)
vp refs   <slug>                  # character sheet + style anchor candidates
vp voice  <slug> [--scene s017]
vp images <slug> [--scene s017] [--variants 2]
vp motion <slug>
vp render <slug> --draft | --final
vp captions <slug>
vp thumbnail <slug>
vp metadata <slug>
vp cost   <slug>                  # estimate before spending
vp run    <slug> --to final       # all stages, pauses at approval gates
```

**Approval gates** (`vp run` stops and prints what to check): after `plan`, after `refs`, after `images` (grid), after `draft`. Continue with `vp run <slug> --resume`.

---

## 13. Review UI (Phase 2)

Next.js pages: `/projects/[slug]` with a scene grid (image, narration, duration, motion type), per-scene actions (regenerate image, edit prompt, swap motion type, play audio), draft player with a scene marker timeline, thumbnail picker, and a cost panel. All actions enqueue jobs; the UI polls job status. Edits to `narration` are **not allowed** in the UI (only via the script file), to preserve the verbatim guarantee.

---

## 14. Cost estimator and budget caps

`vp cost` prints an estimate before any paid call, using `config/pricing.json` (never hardcode prices; they change). Starting values to verify on the official pricing pages:

| Item | Basis (verify) |
|---|---|
| TTS | ElevenLabs Multilingual v2: 1 credit per character; Flash/Turbo: 0.5 credit |
| Images | Gemini image about $0.045 to $0.15 per image; FLUX.2 about $0.03 to $0.07 per megapixel |
| AI clips | Veo 3.1 Lite about $0.05 per second (no audio); Kling 3.0 about $0.10 to $0.20 per second |

Typical 10-minute video: about 11,000 TTS characters, about 110 images, about 20 clips of 5 seconds. Settings: `maxUsdPerRun` (default 40), `maxAiClipShare` (default 0.15), `maxRetriesPerAsset` (default 2). The run aborts before exceeding a cap and prints what it would have cost.

---

## 15. Safety and policy rules (enforced in code)

1. Script content filter before any image prompt: block prompts that depict graphic injury, gore, self-harm or its methods; replace with symbolic imagery or fail the scene with a clear message.
2. No real, named people in image prompts; no copyrighted characters or brand logos.
3. No voice cloning of real people; narrator voices come from `voices.json` only.
4. Sources are mandatory metadata for factual scripts: warn if `sources` is empty.
5. Log every provider call with scene id and cost, but never log API keys or full signed URLs.
6. Do not publish or upload anything automatically.

---

## 16. Testing and acceptance criteria

**Unit tests:** script parser; scene schema; verbatim check (including a deliberately altered LLM output); timeline math (section 8 invariants, mixed fade/cut joins); SRT generator (no overlap, correct format); chapters generator; cost estimator.

**Offline integration test (no API calls).** Mock providers: images = solid-color PNGs with the scene number drawn by ffmpeg `drawtext`, audio = sine tones of known length. Run the full pipeline on a 12-scene script and assert:
- output exists, 1920x1080, 30 fps, H.264 `yuv420p`, AAC 48 kHz;
- video duration equals `sum(D_i) + T/2` within 1 frame;
- audio duration equals video duration within 1 frame;
- A/V drift at the end is under 40 ms; the scene-number frames change at the expected times (sample frames with ffmpeg and compare);
- no black frames at joins except `fadeblack`;
- integrated loudness within -14 LUFS +/- 1.

**Live smoke test** (real providers, 8 scenes, about 60 seconds of video): all stages succeed, total cost printed and under cap, no text detected in images, character sheet consistency judged OK by the user.

**Definition of done for v1:** a 10-minute script produces a final MP4 and 3 thumbnails with one command plus approvals, resumable after any failure, total hands-on time under 30 minutes.

---

## 17. Build order for the coding agent

1. Scaffold TypeScript project, config loading, logger, `vp doctor`.
2. Script parser + scene schema + SRT/chapters utilities (with tests).
3. Timeline module and its invariant tests (section 8). **Do this before any rendering.**
4. ffmpeg render module with mocked inputs (sections 9.1 to 9.4); pass the offline integration test.
5. Providers: `AnthropicPlanner` + verbatim check, `ElevenLabsTts`, then `GeminiImage`/`FluxImage`.
6. Reference bootstrapping (`vp refs`) and style presets.
7. Motion: Ken Burns variants, then `FalVideo` with fallback logic.
8. Thumbnail generator and metadata.
9. `vp run` orchestration with approval gates, caching, cost caps.
10. Phase 2: NestJS + queue + Next.js review UI.

---

## 18. Open decisions (answer before step 5)

- Narrator voice: the developer's own recorded voice, or a licensed synthetic voice?
- Image provider default: run a 10-image consistency test (same style, 3 characters, 2 poses) on Gemini and FLUX before choosing.
- Background music: none, or a licensed library track?
- Captions: SRT only, or burned in as well?
- Languages: English only in v1; a second language (for example Vietnamese) would need a translation stage plus a new TTS voice and re-timed timeline.
