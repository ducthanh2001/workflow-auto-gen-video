#!/usr/bin/env node
// vp-doctor: asks the running API for its dependency report (ffmpeg + filters, fonts, DB, Redis,
// which keys are configured). It never prints key values: the API only reports configured/missing.
//
//   APP_PASSWORD=... node scripts/vp-doctor.mjs [http://127.0.0.1:4000]

const base = process.argv[2] ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const password = process.env.APP_PASSWORD ?? "";

const ok = (b) => (b ? "\x1b[32mok\x1b[0m" : "\x1b[31mFAIL\x1b[0m");

try {
  const res = await fetch(`${base}/health/deps`, {
    headers: { authorization: "Basic " + Buffer.from(`doctor:${password}`).toString("base64") },
  });
  if (res.status === 401) {
    console.error("The API rejected the password. Set APP_PASSWORD to the same value as in .env.");
    process.exit(2);
  }
  const r = await res.json();
  console.log(`ffmpeg      ${ok(r.ffmpeg.ok)}  ${r.ffmpeg.version ?? r.ffmpeg.error ?? ""} ${r.ffmpeg.missing?.length ? "missing: " + r.ffmpeg.missing.join(", ") : ""}`);
  console.log(`fonts       ${ok(r.fonts.ok)}  ${r.fonts.missing.join(", ")}`);
  console.log(`postgres    ${ok(r.db.ok)}  ${r.db.error ?? ""}`);
  console.log(`redis       ${ok(r.redis.ok)}  ${r.redis.error ?? ""}`);
  console.log("keys:");
  for (const [k, v] of Object.entries(r.keys)) console.log(`  ${k.padEnd(20)} ${v}`);
  if (r.mockProviders) console.log("providers   MOCK (no real service is called)");
  for (const w of r.warnings) console.log(`warning: ${w}`);
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(`Could not reach the API at ${base}: ${e.message}`);
  console.error("Is it running? (docker compose up -d)");
  process.exit(2);
}
