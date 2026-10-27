#!/usr/bin/env node
// Live smoke test (spec 17): REAL providers, 8 scenes, about 60 seconds of video.
// It spends real money (a few dollars at most) and prints what it spent.
//
//   1. Fill .env (all keys, GEMINI_IMAGE_MODEL, a real voiceId in config/voices.json with commercialUseConfirmed: true)
//   2. docker compose up -d
//   3. APP_PASSWORD=... node scripts/smoke-live.mjs [http://127.0.0.1:4000]
//
// The script clicks through every approval gate for you. It does NOT judge the pictures: look at the
// scenes and the character consistency yourself in the UI afterwards.

const base = process.argv[2] ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const auth = "Basic " + Buffer.from(`smoke:${process.env.APP_PASSWORD ?? ""}`).toString("base64");

const SCRIPT = `---
title: Smoke test - how a candle burns
language: en
voice: narrator_calm
style: warm-ink-cartoon
target_minutes: 1
sources:
  - https://example.org/candle
---

## Hook
A single candle sits on a table in a dark room, and its small flame seems to hold perfectly still. But that calm is an illusion, because the flame is a busy machine that never stops working.

## The wick
Heat from the flame melts the wax near the wick. The liquid wax climbs the wick the way water climbs a paper towel, drawn upward by tiny gaps between the fibres.

## The flame
At the top, the wax turns into vapor, and the vapor burns. The bright yellow glow comes from tiny specks of carbon heated until they shine, while the blue base burns hotter and cleaner.

## Why it matters
Every part of this tiny engine depends on the others, which is why a candle can burn steadily for hours. Take away the wick, the wax or the air, and the flame simply goes out.
`;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json?.message ?? text}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => `$${Number(n).toFixed(3)}`;

const deps = await call("GET", "/health/deps");
if (!deps.ok) throw new Error("Dependencies are not healthy: run `node scripts/vp-doctor.mjs`");
if (deps.mockProviders) console.log("note: the server runs MOCK providers, so this is not a live test.");

let p = await call("POST", "/projects", { script: SCRIPT });
console.log(`project ${p.id} created`);
const id = p.id;
const t0 = Date.now();
const STALL_MS = 15 * 60_000;

let lastChange = Date.now();
let lastKey = "";
await call("POST", `/projects/${id}/run`, { to: "done" });

for (;;) {
  p = await call("GET", `/projects/${id}`);
  const key = `${p.status}|${p.activeJobs}|${p.spentUsd}`;
  if (key !== lastKey) {
    lastKey = key;
    lastChange = Date.now();
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${p.status}  jobs:${p.activeJobs}  spent:${usd(p.spentUsd)}`);
  }
  if (p.status === "done") break;
  if (Date.now() - lastChange > STALL_MS) throw new Error(`stalled at ${p.status}`);

  if (p.awaitingGate) {
    if (p.awaitingGate === "refs_approved") {
      const refs = await call("GET", `/projects/${id}/refs`);
      if (!refs.anchors.length) throw new Error("no style anchors were generated");
      await call("POST", `/projects/${id}/refs/select`, { anchorAssetId: refs.anchors[0].id });
      console.log("  picked style anchor #1 (look at the others in the UI if you disagree)");
    }
    await call("POST", `/projects/${id}/approve/${p.awaitingGate}`);
    console.log(`  approved ${p.awaitingGate}`);
  } else if (p.activeJobs === 0 && p.runTo) {
    const scenes = await call("GET", `/projects/${id}/scenes`);
    const failed = scenes.filter((s) => s.status === "failed");
    if (failed.length) {
      console.log(`  ${failed.length} scene(s) failed: ${failed[0].error}`);
      throw new Error("a scene failed; fix the cause and use Retry in the UI");
    }
  }
  await sleep(2000);
}

const outputs = await call("GET", `/projects/${id}/outputs`);
const scenes = await call("GET", `/projects/${id}/scenes`);
const est = await call("GET", `/projects/${id}/estimate`);
console.log("\nDone.");
console.log(`  scenes:   ${scenes.length}`);
console.log(`  spent:    ${usd(p.spentUsd)} (cap ${usd(p.settings.maxUsdPerRun)}, estimate was ${usd(est.total)})`);
console.log(`  outputs:  ${outputs.map((o) => o.name).join(", ")}`);
console.log(`  open:     ${base.replace(":4000", ":3000")}/projects/${id}`);
if (p.spentUsd > p.settings.maxUsdPerRun) process.exitCode = 1;
