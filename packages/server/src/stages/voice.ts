import path from "node:path";
import { promises as fs } from "node:fs";
import { ProviderError, checkSpeechAudio, probe, runFfmpeg } from "@vp/core";
import { cacheKeyOf, hashBuffers } from "../assets";
import { projectKey } from "../storage";
import { markDownstreamStale } from "../stale";
import { fatal, loadProject, loadScene, loadScenes, saveScene, withTmp, type StageFn } from "./common";

/** Voice (spec 6.4): one WAV (48 kHz mono) per scene, true duration from ffprobe. */
export const voiceStage: StageFn = async (ctx, data) => {
  if (!data.sceneId) throw fatal("voice job needs a sceneId");
  const project = await loadProject(ctx, data.projectId);
  const scene = await loadScene(ctx, data.sceneId);
  const scenes = await loadScenes(ctx, project.id);
  const voice = ctx.cfg.voices[project.settings.voice];
  if (!voice) throw fatal(`voice "${project.settings.voice}" is not defined in config/voices.json`);
  if (!ctx.cfg.mockProviders && !voice.commercialUseConfirmed) {
    throw fatal(`voice "${project.settings.voice}" is not marked commercialUseConfirmed in config/voices.json`);
  }

  const prev = scenes[scene.idx - 1]?.narration;
  const next = scenes[scene.idx + 1]?.narration;
  const gen = scene.gen?.voice ?? 0;
  const cacheKey = cacheKeyOf({
    provider: ctx.providers.tts.id, model: voice.model, prompt: scene.narration,
    refsHash: hashBuffers(voice.voiceId, prev ?? "", next ?? ""), params: { settings: voice.settings ?? null, gen },
  });

  let asset = await ctx.assets.findByCacheKey(project.id, cacheKey);
  let cost = 0;
  if (!asset) {
    asset = await withTmp(async (tmp) => {
      const out = path.join(tmp, "scene.wav");
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await ctx.providers.tts.synthesize({
          text: scene.narration, voiceId: voice.voiceId, model: voice.model, settings: voice.settings, previousText: prev, nextText: next,
        });
        cost += res.costUsd;
        const raw = path.join(tmp, "raw." + (res.mime.includes("wav") ? "wav" : "mp3"));
        await fs.writeFile(raw, res.audio);
        await runFfmpeg(["-i", raw, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
        const check = await checkSpeechAudio(out);
        if (check.ok) break;
        if (attempt === 1) throw new ProviderError(`TTS output was ${check.reason} twice for scene ${scene.idx + 1}`, undefined, false, "invalid");
      }
      const info = await probe(out);
      const storageKey = projectKey(project.id, "audio", `s${String(scene.idx + 1).padStart(4, "0")}-${cacheKey.slice(0, 8)}.wav`);
      const bytes = await ctx.storage.putFile(storageKey, out);
      return ctx.assets.create({
        projectId: project.id, sceneId: scene.id, type: "audio", storageKey, mime: "audio/wav",
        provider: ctx.providers.tts.id, model: voice.model, params: { voice: project.settings.voice, gen },
        cacheKey, costUsd: cost, durationSec: info.audio?.durationSec ?? info.durationSec, bytes,
      });
    });
  }

  scene.audioAssetId = asset.id;
  scene.audioDurationSec = asset.durationSec;
  scene.errors = { ...scene.errors, voice: undefined };
  await saveScene(ctx, scene);
  await markDownstreamStale(ctx, project, scene.id, "audio");
  await ctx.events.publish(project.id, "asset", { kind: "audio", sceneId: scene.id, assetId: asset.id });
  return { costUsd: cost };
};
