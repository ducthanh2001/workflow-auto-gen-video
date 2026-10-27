# Script-to-Video Studio

Paste an English script → the app splits it into scenes, voices them (ElevenLabs), paints them (Gemini image),
renders a 1920×1080 video with smooth crossfades, burned-in captions and a music bed that ducks under the voice,
then makes 3 thumbnails and the YouTube metadata. You approve each stage in a web UI; nothing is uploaded for you.

Built from [`video-pipeline-spec-v2.md`](video-pipeline-spec-v2.md). Stack: Next.js · NestJS · PostgreSQL (TypeORM) · BullMQ/Redis · ffmpeg 7.

> **Tóm tắt:** `cp .env.example .env`, điền khóa API và `APP_PASSWORD`, sửa `voiceId` trong `config/voices.json`,
> rồi `docker compose up -d --build` và mở http://127.0.0.1:3000. Muốn thử giao diện mà không tốn tiền:
> `PROVIDERS=mock docker compose up -d --build`.

## Quick start

```bash
cp .env.example .env            # then edit it (see "Configuration")
docker compose up -d --build
node scripts/vp-doctor.mjs      # checks ffmpeg + filters, fonts, DB, Redis, which keys are set
```

Open <http://127.0.0.1:3000> (any user name, password = `APP_PASSWORD`). Ports are published on `127.0.0.1` only.

**Try it without spending anything:** `PROVIDERS=mock docker compose up -d --build`. Mock providers return sine-wave
"voices", generated pictures and a rule-based scene planner, so you can click through every screen.

### Configuration

| What | Where |
|---|---|
| API keys, password, model ids | `.env` (server-side only; the browser never receives them) |
| `GEMINI_IMAGE_MODEL` | `.env`. Set it to the image-capable Gemini model your account can use |
| `APIZ_API_KEY`, `APIZ_IMAGE_MODEL` | `.env`. When both are set, pictures come from the APIZ gateway (`POST /v1/images/generations`, Bearer key) instead of Gemini. A scene with people is drawn with `POST /v1/images/edits` (multipart, the hero sheet as the one reference picture the gateway takes per call); scenes without people use `/images/generations`. Set `image.usdPerImage` in `config/pricing.json` to the model's price. `IMAGE_PROVIDER=gemini` switches back |
| Narrator voice | `config/voices.json`. Audition 3 voices on your opening, put the chosen `voiceId` in, set `commercialUseConfirmed: true` only if you may use it commercially. Real runs refuse voices that are not confirmed |
| Visual style, camera moves, caption look | `config/styles/*.yaml` |
| Prices used for estimates and the budget cap | `config/pricing.json` (starting values; verify them on the providers' pages) |
| Timeline constants, chunk size, loudness target, AI clip model | `config/providers.json` |
| Music | upload on the **Music** page; a license note is mandatory |

Per project (Cost & settings tab): budget cap (default $40), AI motion clips share (default 15%, `Off` disables them),
captions burned in on/off, music track. `.srt` is always exported.

## Using it

1. **New project**: paste or upload a script (format below). The right-hand panel shows beats, word count and warnings.
2. **Plan**: scenes of 12–20 words with a picture description each. Narration is locked (verbatim-checked against your script);
   you can edit visuals, shots, camera, motion and transitions. Approve.
3. **References**: a character sheet and 4 style anchors are generated; pick an anchor (or upload your own character sheet). Approve.
4. **Scenes**: voice and images are generated per scene. Redo any scene; failed scenes show an error and a Retry button
   while the rest keeps going. Approve the images.
5. **Draft**: a 960×540 preview with scene and chapter markers on the progress bar. Approve.
6. **Final**: 1080p MP4 + SRT + ASS + `metadata.md` + `report.json`, then **Thumbnails** (A/B/C, shown at full size and at 168×94).

"Run to next approval" (top right) advances until the next gate. Changing a scene afterwards marks the draft/final
**out of date**; render again. A run is resumable after any failure.

### Script format

```markdown
---
title: What Happens in the First 24 Hours After You Die?
language: en
voice: narrator_calm        # key in config/voices.json
style: warm-ink-cartoon     # key in config/styles/*.yaml
target_minutes: 10
sources:
  - https://example.org/paper-1
---

## Hook
At 3:12 on a quiet afternoon, a heart stops. ...

## What "dead" means
Doctors use two standards ...
```

`##` headings are beats: they become YouTube chapters and are never narrated. Everything else is narration and is
never rewritten, reordered, added to or dropped. Limits: 200 KB, at least 100 words; a warning if `sources` is empty.

## Layout

```
apps/web      Next.js review UI (proxy.ts = password; /api/* is proxied to the API)
apps/api      NestJS REST + SSE (enqueues jobs, reads state)
apps/worker   BullMQ workers: plan, voice (3), image (4), clip (2), render (1), thumb
packages/core pipeline logic with no framework: parser, planner, timeline, ffmpeg render, captions,
              thumbnails, metadata, cost, providers (real + mock). Tested without the web app, DB or queue
packages/server TypeORM entities + migration, storage, orchestrator (state machine, gates, budget guard, stale), stages
packages/shared zod schemas and DTOs
config/, assets/fonts/ (OFL: Inter, Anton)
```

`packages/server` is not in the spec's tree: the API and the worker both need the entities, the orchestrator and the
stage implementations, so they live in one shared package instead of one importing the other.

The sync math (spec §8) is in `packages/core/src/timeline.ts` with its invariant tests. Slot boundaries are rounded to
whole frames cumulatively, so every `xfade` offset is frame-exact and there is no drift over a long video.

## Development

Needs Node ≥ 20, pnpm, Docker; for the render tests an ffmpeg with libx264/libass (the Docker image has 7.1).

```bash
pnpm install
pnpm build                       # packages, then apps
pnpm services:up                 # throwaway Postgres (54329) + Redis (63799) for the e2e tests
export FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe   # if they are not on PATH
pnpm test                        # core (unit + offline render integration), server pipeline e2e, API e2e
pnpm services:down
```

* `packages/core` tests need only ffmpeg; the render integration test skips itself without it.
* `packages/server` and `apps/api` e2e tests use real Postgres, Redis, BullMQ and ffmpeg with **mock providers**
  (`DATABASE_URL`/`REDIS_URL` default to the `services:up` ports; override with `TEST_DATABASE_URL` / `TEST_REDIS_URL`).
  They drop the `public` schema of that database, so never point them at a database you care about.
* **Live smoke test** (real providers, 8 scenes, a few dollars): fill `.env` and `voices.json`, start the stack, then
  `APP_PASSWORD=... pnpm smoke:live`. It clicks through the gates and prints what was spent; judge the pictures yourself.

Local (non-Docker) run: start Postgres + Redis, set `DATABASE_URL`, `REDIS_URL`, `DATA_DIR`, `APP_PASSWORD`, then
`node apps/api/dist/main.js`, `node apps/worker/dist/main.js`, and `pnpm --filter @vp/web dev`.

## What is verified, and what is not

Verified by automated tests: the timeline invariants; script parsing; the verbatim gate (including a deliberately altered
LLM answer); captions/chapters/cost/budget; the whole render on mock assets (output format, duration = Σ slots + T/2,
A/V drift, scene changes at the expected frames, no black frames at joins except `fadeblack`, captions inside speech
windows, ≥ 6 dB music ducking, −14 LUFS ± 1); the state machine with every gate, per-scene regenerate → stale flags, the
budget guard (HTTP 402 with the numbers), failure of one scene without failing the project, and the HTTP contract.

**Not verified here** (needs your keys and money): the real ElevenLabs, Gemini, Anthropic and fal calls, the OCR "no text in
the image" check on real pictures, and whether the characters look consistent. Those request formats follow each provider's
public API but were never run against the live services in this repository; run `pnpm smoke:live` first.

## Decisions worth knowing

* Narration is normalized to about −18 LUFS before mixing so the music ducking depth does not depend on how loud a
  particular TTS voice is. The final mix is then two-pass normalized to −14 LUFS.
* `xfade`'s `fadeblack` reaches black early in the transition (not at 50%); the tests account for that.
* Images are stored as 3840×2160 JPEG (quality 95, 4:4:4) rather than PNG to keep disk use sane.
* On-screen text (`onScreenText`) is drawn from glyph outlines into a transparent PNG and overlaid with a fade;
  `drawtext` is never used with user text.
* Next.js standalone output is enabled only in the Docker build (`NEXT_STANDALONE=1`); copying pnpm's symlinks fails on Windows.
