# Script-to-Video Studio: Build Spec (v2)

> **Tóm tắt (Vietnamese):** Bản đặc tả này thay thế bản đầu. Sản phẩm là một **web app** (Next.js + NestJS + PostgreSQL + hàng đợi): bạn dán kịch bản tiếng Anh, hệ thống tự chia cảnh, tạo giọng đọc bằng ElevenLabs, tạo ảnh bằng Gemini image, ghép hình với tiếng khớp nhau bằng ffmpeg với chuyển cảnh mượt, in phụ đề lên video, trộn nhạc nền tự hạ nhỏ khi có giọng, rồi tạo 3 thumbnail và metadata để đăng YouTube. Đưa file này cho AI coding agent trong VS Code và làm theo mục "Build order".

---

## 0. Decisions already made

| Topic | Decision |
|---|---|
| Voice | ElevenLabs (AI voice), behind a `TtsProvider` interface |
| Image model | Gemini image only (model id from env), behind an `ImageProvider` interface |
| Product form | Web app from day one: Next.js + NestJS + PostgreSQL (TypeORM) + BullMQ/Redis |
| Captions | `.srt` file always exported **and** captions burned into the video |
| Music | Background music bed with automatic ducking under narration; tracks are uploaded by the user with a license note |
| Language | English narration only in v1 |

Defaults used where the user did not decide (change in config): AI motion clips are optional and capped at 15% of scenes; per-run budget cap $40; single-user app on localhost behind a password; everything runs in Docker Compose.

---

## 1. Goal and non-goals

**Goal.** Input: one script. Output: a finished 1920x1080 MP4 whose narration is aligned with the visuals, with burned-in captions and a music bed; plus 3 thumbnail variants, an SRT file and a YouTube metadata file (title options, description with chapters, sources).

**Non-goals (v1).**
- No automatic upload to YouTube; the user uploads manually.
- No face-on-camera avatars, no real people, no voice cloning of real people.
- No manual timeline editor. A scene grid with regenerate buttons is enough.
- No multi-user accounts or billing.

**Originality rule (important).** The visual style is a *generic* look: simple round-headed cartoon people on a richer painted background, warm/cool light contrast. The product ships with the user's **own original characters** and its own thumbnail language. It must NOT reproduce any existing channel's characters, logo, name or thumbnails, and style presets must never contain another channel's name.

---

## 2. Inputs and outputs

### 2.1 Script format (`script.md`, pasted or uploaded)

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
- Everything else is narration, in order. The pipeline must never rewrite, reorder, add or drop narration words (see 6.2 verbatim check).
- Limits: file size at most 200 KB; at least 100 words; warn if `sources` is empty.

### 2.2 Outputs (per project)

| Asset | Description |
|---|---|
| `final.mp4` | 1920x1080, 30 fps, H.264 `yuv420p`, AAC 48 kHz, `+faststart`, integrated loudness about -14 LUFS, captions burned in, music mixed |
| `draft.mp4` | 960x540 fast preview of the same timeline (captions on) |
| `captions.en.srt` | Sentence-level captions aligned to the **narration audio** (see 9.2) |
| `captions.ass` | Styled version used for burn-in |
| `thumbnail_A/B/C.jpg` | 1280x720 JPG, each under 2 MB (verify YouTube's current limit) |
| `metadata.md` | Title options, description with chapters, sources, disclosure lines, tags |
| `report.json` | Per-stage cost, durations, retries, measured A/V drift |

---

## 3. Architecture

### 3.1 Monorepo (pnpm workspaces, TypeScript, Node 20+)

```
apps/
  web/        Next.js (App Router) review UI
  api/        NestJS REST API + SSE, TypeORM, migrations
  worker/     BullMQ workers (one process, one processor per stage queue)
packages/
  core/       pipeline logic with no framework dependency:
              parser, planner, timeline, render (ffmpeg), captions, thumbnail,
              metadata, cost estimator, providers
  shared/     zod schemas and DTO types used by web, api, worker
config/
  styles/*.yaml, voices.json, providers.json, pricing.json
assets/fonts/ OFL-licensed fonts (captions + thumbnails)
docker-compose.yml
```

`packages/core` is the heart: it must run and be tested **without** the web app, DB or queue (pure functions plus provider interfaces). The worker calls it; the API only enqueues jobs and reads state.

### 3.2 Runtime (Docker Compose)

Services: `postgres`, `redis`, `api`, `worker` (image includes `ffmpeg` 7.x and `ffprobe`, with `libx264`, `libass`, and the `zoompan`, `xfade`, `loudnorm`, `sidechaincompress` filters), `web`. One shared volume `/data` for assets. `vp-doctor` script (or `GET /health/deps`) verifies ffmpeg version and filters, fonts, DB, Redis and which API keys are configured (never prints key values).

### 3.3 Storage

A `StorageService` interface with a local-disk implementation writing under `/data/projects/<projectId>/...` (S3-compatible implementation later). Assets are addressed by **asset id**, never by user-supplied paths.

### 3.4 Security (single-user v1)

- Whole app behind a password (`APP_PASSWORD`, HTTP basic or a login page). Default bind: `127.0.0.1`.
- Provider API keys only in server env; the browser never receives them; the UI shows only "configured / missing".
- Upload validation: scripts `.md`/`.txt` up to 200 KB; music `.mp3`/`.wav` up to 50 MB; verify MIME and run `ffprobe` before accepting.
- Never build shell strings from user text; call ffmpeg with an **argument array** (`execa`). The bash snippets in this spec are illustrative.
- Prevent path traversal in asset serving (lookup by id). Serve video with HTTP Range support for the preview player.

---

## 4. Data model (PostgreSQL via TypeORM migrations; `synchronize` off)

| Entity | Main fields |
|---|---|
| `Project` | id, slug, title, status (state machine, section 5), settings (jsonb: style, voice, fps, T, captions, music, budget), scriptRaw, createdAt |
| `Scene` | id, projectId, idx, beat, narration (immutable after planning), visual, shot, camera, motion, transitionOut, onScreenText, approved, status, audioAssetId, imageAssetId, clipAssetId, audioDurationSec, slotSec |
| `Asset` | id, projectId, sceneId?, type (`ref`,`audio`,`image`,`clip`,`segment`,`chunk`,`video`,`thumbnail`,`srt`,`ass`,`music_mix`), storageKey, provider, model, params (jsonb), cacheKey (unique per project), costUsd, durationSec, bytes, createdAt |
| `Job` | id, projectId, sceneId?, stage, status (`queued`,`running`,`succeeded`,`failed`), attempts, error, costUsd, startedAt, finishedAt |
| `MusicTrack` | id, name, storageKey, durationSec, **licenseNote (required, non-empty)**, createdAt |

`Asset.cacheKey = sha256(provider + model + prompt + refsHash + params)`. If an asset with the same key exists, skip the provider call (idempotent, resumable, saves money).

### 4.1 Scene schema (shared zod)

```ts
export const SceneDraft = z.object({
  beat: z.string(),
  narration: z.string().min(1),             // verbatim slice of the script
  visual: z.string().min(10),               // concrete, no text/letters/logos, no real people
  shot: z.enum(["wide","medium","close","detail"]),
  camera: z.enum(["push_in","pull_out","pan_left","pan_right","tilt_up","tilt_down","static"]),
  motion: z.enum(["kenburns","ai_clip"]),
  transitionOut: z.enum(["cut","fade","fadeblack","dissolve"]),
  onScreenText: z.string().max(40).nullable(),
});
export const ScenePlan = z.object({ scenes: z.array(SceneDraft).min(1) });
```

---

## 5. Project state machine and approval gates

```
created -> parsed -> planned -> [gate: plan_approved]
        -> refs_ready -> [gate: refs_approved]
        -> voiced -> imaged -> [gate: images_approved]
        -> motion_done -> draft_rendered -> [gate: draft_approved]
        -> final_rendered -> thumbnails_ready -> metadata_ready -> done
```

- `POST /projects/:id/run {to}` advances through stages and **stops at each gate**; the user approves in the UI (`POST /projects/:id/approve/:gate`) and the run resumes.
- Any stage can be re-run for a single scene (regenerate); downstream stages are marked stale (for example a new image makes `segment`, `chunk`, `draft`, `final` stale).
- Failure of one scene does not fail the project: the scene shows an error and a Retry button; the run waits at that stage.

---

## 6. Pipeline stages

### 6.1 Parse
Front matter (`gray-matter`), beats, paragraphs; normalize whitespace and quotes; apply the limits from 2.1.

### 6.2 Scene planning (LLM)
Call the Anthropic API (model string `claude-sonnet-5-5`) with the script and these rules. Validate the result with `ScenePlan`.

1. Scenes of **12 to 20 words** (about 4 to 8 seconds at ~190 words per minute). Prefer sentence boundaries; split mid-sentence only when a sentence exceeds 30 words.
2. `narration` is an **exact slice** of the script. Do not paraphrase, fix grammar, add or remove words.
3. `visual` is concrete, shows one clear idea, has **no text, letters, numbers or logos**, **no real named people**.
4. Vary `shot` and `camera`; alternate `push_in` and `pull_out`; no more than 3 identical shots in a row.
5. `motion: "ai_clip"` for at most `maxAiClipShare` (default 15%) of scenes and only where movement carries meaning (fire, rain, water, clock hands). Otherwise `kenburns`.
6. `transitionOut`: `fade` by default; `fadeblack` on the last scene of a beat; `cut` between two scenes continuing the same moment.
7. Sensitive-topic rule: no gore, no graphic bodies, no depiction of self-harm or methods of death; use symbols (clock, hands, candle, stylized figures).

**Verbatim check (hard gate).** Normalize (lowercase, strip punctuation and whitespace) and assert `concat(scene.narration) === concat(script narration)`. On mismatch retry up to 2 times with the diff in the prompt, then fail with a clear error. After planning, `narration` is immutable in DB and UI.

### 6.3 Reference bootstrapping (`refs`)
Once per project: generate a **character sheet** (3 poses on a plain background) and 4 candidate **style anchors** with Gemini image using the style preset. The user picks one anchor in the UI; character sheet and anchor are saved as `ref` assets and passed to every image call. Gate: `refs_approved`.

### 6.4 Voice (ElevenLabs)
`POST /v1/text-to-speech/{voice_id}` per scene.

- One audio file per scene; convert to WAV 48 kHz mono.
- Pass previous/next scene text as context if the API supports it, so prosody flows across scene boundaries.
- Measure the true duration with `ffprobe` (never estimate from word count). Store `audioDurationSec`.
- Reject silent or clipped output and retry once.
- Improvement (v2): synthesize per paragraph and cut scene boundaries with word timestamps from forced alignment; same timeline math.

### 6.5 Images (Gemini image)
Prompt per scene:

```
{style.prefix}
Characters: {style.characters}
Scene: {scene.visual}
Framing: {scene.shot} shot, 16:9.
{style.suffix}
Hard constraints: no text or letters in the image, no watermark, no real people.
```

- Pass up to 3 references: character sheet, style anchor, and (optional) the previous scene's image. Model id comes from `GEMINI_IMAGE_MODEL`; set it to the image-capable Gemini model your account can use (check Google's current docs).
- Request 16:9 at the largest supported size, then upscale/crop with `sharp` to **3840x2160** (keeps Ken Burns sharp).
- 1 version by default; `variants: 2` for important scenes.
- Auto-checks: dimensions, not blank, and an OCR pass; if text is detected regenerate once with a stronger "no text" constraint.
- Concurrency 4 with a rate-limit-aware limiter; honor `429 Retry-After`.

### 6.6 Motion
- **Ken Burns (default)**, derived from `scene.camera` (9.1).
- **AI clip (optional, capped).** Image-to-video through fal.ai (Kling 3.0 or Veo 3.1 Lite; configurable in `providers.json`; `maxAiClipShare: 0` turns the feature off). Prompt = scene visual plus one short motion instruction ("flames flicker, rain falls, camera holds"). Request a 5 second clip.
- Clip shorter than `L_i`: loop ping-pong or slow by up to 15%; if still short, hold the last frame. Longer: trim.
- Provider error or bad result: fall back to Ken Burns for that scene and record it in `report.json`.

### 6.7 Timeline, render, captions, music
Compute the timeline (section 8), render segments, chunks, the audio mix, burn captions, mux (section 9).

### 6.8 Thumbnails and metadata
Sections 10 and 11.

---

## 7. Style system

YAML in `config/styles/`. Default preset (generic look; the user supplies their own character sheet):

```yaml
name: warm-ink-cartoon
aspect: "16:9"
prefix: >
  2D flat cartoon illustration with thick dark outlines. Characters are simple:
  round heads, dot eyes, tiny mouth, thin stick limbs, simple garments.
  Backgrounds are richer and more painterly than the characters, with soft
  shading and detailed textures. Strong warm and cool light contrast
  (orange firelight against deep blue night). Limited, harmonious palette.
characters: >
  Use the attached character sheet exactly: same head shape, face style,
  proportions and line weight. Clothing may change per scene.
suffix: >
  Cinematic wide composition, clear focal point, uncluttered foreground,
  no text anywhere in the image.
camera_defaults:
  push_in:   { zoomStart: 1.00, zoomEnd: 1.10 }
  pull_out:  { zoomStart: 1.10, zoomEnd: 1.00 }
  pan_left:  { zoom: 1.08, xFrom: 0.55, xTo: 0.45 }
  pan_right: { zoom: 1.08, xFrom: 0.45, xTo: 0.55 }
  tilt_up:   { zoom: 1.08, yFrom: 0.55, yTo: 0.45 }
  tilt_down: { zoom: 1.08, yFrom: 0.45, yTo: 0.55 }
captions:
  font: "Inter"            # bundled OFL font in assets/fonts
  size: 54                 # at 1080p
  bold: true
  outline: 3
  marginV: 60
  maxCharsPerLine: 42
  maxLines: 2
```

Design the character sheet to be your own: change head shape, hair/fur treatment, color accents and clothing marks so the look is distinct from other channels.

---

## 8. Timeline and sync math (the core of "khớp")

Constants (config): `fps = 30`, `LEAD = 0.20 s`, `TAIL = 0.30 s`, `TAIL_BEAT = 0.60 s` (last scene of a beat), `T = 0.40 s` (crossfade length; require `T <= LEAD + TAIL - 0.1`).

For scene *i* with measured audio duration `a_i`:

```
D_i = LEAD + a_i + TAIL            # slot (TAIL_BEAT replaces TAIL at beat ends)
A_i = sum_{j<i} D_j                # slot start in VIDEO time (A_1 = 0)
```

Each segment is rendered **longer than its slot** so the fade can overlap its neighbor. Let `T_i` be the fade length of the join after scene *i* (`T` for fade/dissolve/fadeblack, `0` for cut):

```
L_i = D_i + T_i        for i < n
L_n = D_n + T/2        (last scene holds its final frame so the video is as long as the delayed narration)
```

**xfade offset** for the join after scene *k*:

```
offset_k = sum_{j<=k} L_j - sum_{j<=k} T_j = sum_{j<=k} D_j = A_{k+1}
```

so every fade **starts exactly at the next slot's start** in video time, for any mix of fades and cuts. The chain's total length is `sum D_i + T/2`.

**Center the transition on the spoken boundary:** delay the whole narration track by `T/2`. Then the fade spans video time `[A_{k+1}, A_{k+1}+T]`, centered on the audio slot boundary `A_{k+1} + T/2`. With `LEAD=0.2`, `TAIL=0.3`, `T=0.4` the fade lies inside the silence between sentences, so words are never covered by a transition.

**Audio-aligned times** (for captions and chapters): a scene's speech starts at `S_i = A_i + T/2 + LEAD` and ends at `E_i = S_i + a_i`.

**Invariants to unit-test:**
1. `offset_k == A_{k+1}` for random mixes of fade and cut joins.
2. Video length `== sum D_i + T/2 ==` narration track length, within 1 frame (33 ms).
3. No fade window `[A_{k+1}, A_{k+1}+T]` overlaps any speech interval `[S_i, E_i]` (shifted by the `T/2` audio delay already included in `S_i`).
4. Beat-end scenes use `TAIL_BEAT`, and chapters use the beat's first `S_i`.

---

## 9. ffmpeg recipes (illustrative; use argument arrays)

### 9.1 Per-scene segment (Ken Burns)

Do **not** use `-loop 1` with `zoompan` (it multiplies frames). Feed the still once; `zoompan` outputs `FRAMES` frames. Pre-scale the still to 2x to 4x the output width to reduce jitter.

```bash
FRAMES=round(L_i * 30)
ffmpeg -y -i images/s001.png \
  -vf "scale=3840:-2,zoompan=z='min(zoom+${STEP},${ZOOM_END})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${FRAMES}:s=1920x1080:fps=30,format=yuv420p" \
  -frames:v ${FRAMES} -c:v libx264 -crf 14 -preset medium -r 30 -an segments/s001.mp4
```

- `STEP = (zoomEnd - zoomStart) / FRAMES`. For `pull_out` use `z='if(lte(on,1),${ZOOM_START},max(${ZOOM_END},zoom-${STEP}))'`.
- Pans: constant zoom; `x='(iw-iw/zoom)*(xFrom+(xTo-xFrom)*on/FRAMES)'` (same for `y` in tilts).
- AI clips: `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p`, trimmed or looped to `L_i`.
- All segments **must share** resolution, fps, pixel format and timebase (`settb=AVTB`) or `xfade` fails.
- `onScreenText` (optional, rare): render a transparent PNG with `sharp` and `overlay` it with a short fade; do **not** use `drawtext` with user text (escaping risks).

### 9.2 Crossfades (chunked)

A single filtergraph with 100+ inputs is slow and fragile. Render **chunks of 10 to 15 scenes**, then join the chunks with the same formula (each chunk is a segment with `L = sum D + T`; only the last chunk ends with `+ T/2`).

```bash
ffmpeg -y -i s001.mp4 -i s002.mp4 -i s003.mp4 \
  -filter_complex "\
[0:v][1:v]xfade=transition=fade:duration=0.4:offset=OFFSET1[v1];\
[v1][2:v]xfade=transition=fade:duration=0.4:offset=OFFSET2[v2]" \
  -map "[v2]" -c:v libx264 -crf 14 -preset medium -pix_fmt yuv420p chunks/chunk_01.mp4
```

Offsets come from the timeline module, relative to the chunk start. `transition` is `fade`, `fadeblack` or `dissolve`; for `cut` use a plain `concat` join. Keep intermediates at CRF 12 to 14 (they are re-encoded once more).

### 9.3 Audio: narration, music bed, ducking, loudness

1. Pad each scene WAV to its slot: `adelay=LEAD*1000` then `apad=whole_dur=D_i`.
2. Concatenate padded files (concat demuxer, PCM), then delay the whole track by `T/2`.
3. Music (if enabled): take the chosen `MusicTrack`. If shorter than the video, loop it with a 2 s `acrossfade` between copies (built in code). Trim to the video length, gain about -18 dB, `afade` in 2 s and out 3 s.
4. Duck and mix:

```
[narr]asplit=2[narr_mix][narr_sc];
[music][narr_sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=500[ducked];
[narr_mix][ducked]amix=inputs=2:duration=first:normalize=0[mix]
```

   `amix` `normalize=0` needs a recent ffmpeg (7.x); verify in the doctor check, and on older builds compensate with `volume=2`.
5. Loudness on the **final mix**: two-pass `loudnorm=I=-14:TP=-1.5:LRA=11` (measure with `print_format=json`, then apply with the measured values and `linear=true`).

Music safety: a track cannot be selected unless its `licenseNote` is non-empty; the app never downloads or generates music.

### 9.4 Final pass: burn captions and mux

Captions are burned into the full assembled video in the **same pass** that muxes audio (so video is encoded only once more):

```bash
ffmpeg -y -i video_all.mp4 -i mix_final.wav \
  -vf "ass=captions.ass:fontsdir=assets/fonts" \
  -map 0:v -map 1:a -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart -t ${TOTAL} out/final.mp4
```

`TOTAL = sum D_i + T/2`. Draft mode: same graph at 960x540, `-crf 28 -preset veryfast`, AI clips replaced by their still frame, captions on.

---

## 10. Captions

- One cue per scene (split a scene into two cues only if it exceeds `maxLines x maxCharsPerLine`), wrapped at `maxCharsPerLine`, at most `maxLines` lines.
- **Timing uses audio-aligned times:** cue start `S_i`, cue end `E_i + 0.15 s` (not video slot times), so captions match speech even though video slots start earlier.
- Generate both `captions.en.srt` and `captions.ass` from the same cue list. The `.ass` style comes from the preset (`PlayResX=1920`, `PlayResY=1080`, bottom-center, outline, no shadow, `MarginV` from preset).
- Unit tests: no overlapping cues, cue times within `[0, TOTAL]`, valid SRT numbering and `HH:MM:SS,mmm` format.

---

## 11. Thumbnail generator

Goal: 3 distinct, high-contrast thumbnails, 1280x720.

1. **Concepts (LLM):** from title and script propose 3 concepts. Rules: one focal subject, strong contrast, large negative space for text, **max 4 words** of text, curiosity-driven but truthful to the video, no gore, no real people, no copying of any existing channel's thumbnails.
2. **Background art (Gemini image):** generate the background **without any text**, using the style preset, character sheet and style anchor.
3. **Text (code, not the image model):** render with `sharp` + SVG or `satori` using a bundled heavy sans-serif; white text with dark stroke; placed in the largest quiet region.
4. **Checks:** text contrast at least 7:1 against the sampled region; text width at most 35% of the frame; nothing important in the bottom-right corner (duration badge); readable when downscaled to 168x94.
5. **Output:** `thumbnail_A/B/C.jpg`, quality 90, under 2 MB. The UI shows them side by side at full size and at tiny size.

---

## 12. Metadata (`metadata.md`)

- **3 title options** (first is the script title), at most 70 characters, no promise the video does not deliver.
- **Description:** two hook lines, chapters, sources, disclosure lines.
- **Chapters** from beats: first at `0:00`, at least 3 chapters, each at least 10 seconds (verify YouTube's current rules). Timestamp = first scene's `S_i` of the beat, formatted `m:ss`; the first chapter is forced to `0:00`.
- **Sources:** the `sources:` list, one per line.
- **Disclosure:** "Educational content, not medical advice." plus an AI-assistance line (synthetic voice and imagery). Remind the user to set YouTube's altered/synthetic-content disclosure in Studio if it applies.
- **Tags:** 8 to 12.

---

## 13. API (NestJS) and jobs

REST, JSON, plus SSE for progress. All routes behind the app password.

| Method and path | Purpose |
|---|---|
| `POST /projects` | Create from pasted script or uploaded `.md`; parses immediately |
| `GET /projects`, `GET /projects/:id` | List, detail (state, cost so far, settings) |
| `PATCH /projects/:id/settings` | Style, voice, captions on/off, music track, budget cap |
| `POST /projects/:id/plan` | Enqueue scene planning |
| `GET /projects/:id/scenes` | Scenes with asset URLs and status |
| `PATCH /scenes/:id` | Edit `visual`, `camera`, `motion`, `transitionOut`, `onScreenText`, `approved` (**never** `narration`) |
| `POST /projects/:id/refs`, `POST /projects/:id/refs/select` | Generate / choose character sheet and style anchor |
| `POST /projects/:id/voice`, `/images`, `/motion` | Enqueue stage for all or `{sceneIds}` |
| `POST /scenes/:id/regenerate/:stage` | Redo one scene's asset, mark downstream stale |
| `GET /projects/:id/estimate` | Cost estimate before spending |
| `POST /projects/:id/run {to}` | Run through stages, pausing at gates |
| `POST /projects/:id/approve/:gate` | Approve a gate |
| `POST /projects/:id/render {mode}` | `draft` or `final` |
| `POST /projects/:id/thumbnails`, `/metadata` | Generate |
| `GET /projects/:id/events` | SSE: job and state changes |
| `GET /assets/:id/content` | Stream an asset (Range support) |
| `POST /music`, `GET /music`, `DELETE /music/:id` | Music library (license note required) |
| `GET /health/deps` | ffmpeg, filters, fonts, DB, Redis, key presence |

**Queues (BullMQ):** `plan`, `voice` (concurrency 3), `image` (concurrency 4), `clip` (concurrency 2), `render` (concurrency 1), `thumb`. Jobs are idempotent via `cacheKey`; retries: 3 attempts with exponential backoff; a job records cost and error in `Job`.

**Budget guard:** before enqueuing a paid job, check `spent + estimate <= maxUsdPerRun`; otherwise refuse with the numbers.

---

## 14. Web UI (Next.js, Tailwind, TanStack Query)

- `/` project list and status.
- `/projects/new` paste or upload a script; shows parse result (beats, word count, warnings).
- `/projects/[id]` stepper with panels:
  1. **Plan:** scene table; edit visual and camera; verbatim-check badge; approve.
  2. **References:** character sheet and 4 style anchors; pick one; regenerate.
  3. **Scenes:** virtualized grid (about 110 scenes): image, narration, duration, motion type, per-scene Regenerate; audio play button; stale/failed badges.
  4. **Draft:** player with scene markers on the progress bar; approve.
  5. **Final and downloads:** `final.mp4`, SRT, thumbnails, `metadata.md`, `report.json`.
  6. **Thumbnails:** three variants at full size and at 168x94; pick.
  7. **Cost panel:** estimate, spent per stage, cap.
- `/music` library with a mandatory license note field.
- `/settings` provider and dependency status only (no key entry).
- Progress comes from SSE; the UI never blocks on a long request.

---

## 15. Cost estimator and budget

`config/pricing.json` (never hardcode prices; verify on official pages). Starting values to verify:

| Item | Basis (verify) |
|---|---|
| TTS | ElevenLabs Multilingual v2: 1 credit per character; Flash/Turbo: 0.5 credit |
| Images | Gemini image about $0.045 to $0.15 per image depending on size |
| AI clips | Veo 3.1 Lite about $0.05 per second (no audio); Kling 3.0 about $0.10 to $0.20 per second |

Typical 10-minute video: about 11,000 TTS characters, about 110 images, 0 to 20 clips of 5 seconds. Settings: `maxUsdPerRun` (default 40), `maxAiClipShare` (default 0.15), `maxRetriesPerAsset` (default 2). Every provider call records its cost in `Asset` and `Job`; the UI shows spend versus cap.

---

## 16. Safety and policy rules (enforced in code)

1. Content filter before any image prompt: block graphic injury, gore, self-harm or its methods; replace with symbolic imagery or fail that scene with a clear message.
2. No real named people in prompts; no copyrighted characters or brand logos.
3. No voice cloning of real people; narrator voices come only from `config/voices.json`, and only voices the user may use commercially.
4. Factual scripts need `sources`; warn if empty.
5. Log every provider call with project/scene id and cost; never log API keys or signed URLs.
6. Music requires a license note; nothing is uploaded or published automatically.

---

## 17. Testing and acceptance criteria

**Unit tests (`packages/core`):** parser; scene schema; verbatim check including a deliberately altered LLM output; timeline invariants (section 8, mixed fade/cut joins); caption generator; chapters generator; cost estimator; budget guard.

**Offline integration test (no API calls).** Mock providers: images = solid-color PNGs with the scene number burned in, audio = sine tones of known length, music = a generated tone. Run the full render on a 12-scene plan and assert:
- output is 1920x1080, 30 fps, H.264 `yuv420p`, AAC 48 kHz;
- video duration `== sum D_i + T/2` and audio duration equals video duration, within 1 frame;
- A/V drift at the end under 40 ms; scene-number frames change at the expected times (sample frames and compare);
- no black frames at joins except `fadeblack`;
- captions appear within the correct speech windows (sample frames at `S_i + 0.2 s`);
- music is audibly lower (RMS drops at least 6 dB) while narration is present than in gaps;
- integrated loudness within -14 LUFS +/- 1.

**API e2e (mocked providers):** create project, plan, approve gates, run to `final_rendered`, regenerate one scene and assert downstream assets become stale.

**Live smoke test** (real providers, 8 scenes, about 60 seconds): all stages succeed, spend printed and under cap, no text detected in images, the user judges character consistency acceptable.

**Definition of done for v1:** a 10-minute script produces a final MP4 (burned captions, music bed) and 3 thumbnails through the web UI with only the approval clicks, resumable after any failure, hands-on time under 30 minutes.

---

## 18. Build order for the coding agent

1. Monorepo scaffold, Docker Compose, config loading, `/health/deps`.
2. `packages/core`: script parser, scene schema, captions and chapters utilities (with tests).
3. `packages/core`: **timeline module and its invariant tests (section 8). Do this before any rendering.**
4. `packages/core`: ffmpeg render module with mocked inputs (sections 9.1 to 9.4); pass the offline integration test including captions and music.
5. Providers: `AnthropicPlanner` with verbatim check; `ElevenLabsTts`; `GeminiImage`; optional `FalVideo`.
6. Reference bootstrapping and style presets.
7. Database entities and migrations; `StorageService`; asset cache.
8. NestJS API, BullMQ queues and worker processors, state machine, SSE, budget guard.
9. Thumbnail generator and metadata generator.
10. Next.js UI: project list, new project, stepper panels, music library, cost panel.
11. API e2e tests and the live smoke test.

---

## 19. Remaining inputs from the user (small)

- Pick the ElevenLabs narrator voice: audition 3 voices on the 60-second opening and put the chosen id in `config/voices.json`.
- Set `GEMINI_IMAGE_MODEL` to the image-capable Gemini model available to your account.
- Provide at least one licensed music track with its license note.
- Decide whether to enable AI motion clips for the first video (default: on, capped at 15%; set `maxAiClipShare: 0` to disable and save cost).
