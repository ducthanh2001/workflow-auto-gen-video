/** HTTP contract e2e: real NestJS app, Postgres, Redis, ffmpeg; providers mocked. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { bins, runFfmpeg } from "@vp/core";
import { createContext, loadConfig, startWorkers } from "@vp/server";
import { createApp } from "../src/app";

const DB = process.env.TEST_DATABASE_URL ?? "postgres://vp:vp@127.0.0.1:54329/vp";
const REDIS = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:63799";
const PASSWORD = "s3cret-test";
const AUTH = "Basic " + Buffer.from(`user:${PASSWORD}`).toString("base64");

function available() {
  try {
    execFileSync(bins.ffmpeg, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SENTENCES = [
  "At three twelve on a quiet afternoon, a heart stops beating in a small hospital room.",
  "For the person lying there, the world does not go dark all at once, it fades in stages.",
  "Doctors use two standards to say that a person has died, and they are not the same thing.",
  "The first is the end of breathing and circulation, which can be seen at the bedside.",
  "The second is the end of all brain function, which needs careful tests before anyone declares it.",
  "Within seconds of the heart stopping, oxygen runs out in the brain and consciousness slips away.",
  "Yet the cells of the body do not die together, and some keep working for hours afterward.",
  "Skin and bone can survive for a day, while neurons begin to fail within minutes.",
  "Researchers have studied these stages for decades, using careful observation and patient records.",
];
const SCRIPT = [
  "---", "title: HTTP Test Video", "language: en", "voice: narrator_calm", "style: warm-ink-cartoon", "sources:", "  - https://example.org/a", "---", "",
  "## Hook", SENTENCES.slice(0, 3).join(" "), "", "## Middle", SENTENCES.slice(3, 6).join(" "), "", "## End", SENTENCES.slice(6).join(" "), "",
].join("\n");

async function waitFor<T>(what: string, fn: () => Promise<T | false | undefined | null>, ms = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe.skipIf(!available())("API e2e", () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof createContext>>;
  let stopWorkers: () => Promise<void>;
  let dataDir: string;
  let baseUrl: string;
  const api = () => request(app.getHttpServer());
  const authed = (m: "get" | "post" | "patch" | "delete", url: string) => api()[m](url).set("Authorization", AUTH);

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-api-"));
    const cfg = loadConfig({ ...process.env, DATABASE_URL: DB, REDIS_URL: REDIS, DATA_DIR: dataDir, PROVIDERS: "mock", OCR: "off", APP_PASSWORD: PASSWORD, JOB_BACKOFF_MS: "30", RENDER_FAST: "1" });
    const { createDataSource } = await import("@vp/server");
    const tmp = createDataSource(DB);
    await tmp.initialize();
    await tmp.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await tmp.destroy();
    ctx = await createContext({ cfg, log: () => undefined });
    await ctx.redis.flushdb();
    stopWorkers = startWorkers(ctx).close;
    app = await createApp(ctx);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await stopWorkers?.();
    await app?.close();
    await ctx?.ds.destroy();
    await ctx?.redis.quit();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("rejects requests without the password", async () => {
    await api().get("/projects").expect(401);
    await api().get("/projects").set("Authorization", "Basic " + Buffer.from("u:wrong").toString("base64")).expect(401);
    await authed("get", "/projects").expect(200);
  });

  it("reports dependencies and key presence without values", async () => {
    const r = await authed("get", "/health/deps").expect(200);
    expect(r.body.db.ok).toBe(true);
    expect(r.body.redis.ok).toBe(true);
    expect(r.body.ffmpeg.missing).toEqual([]);
    expect(r.body.fonts.ok).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/sk-|AIza/);
    expect(Object.values(r.body.keys).every((v) => v === "configured" || v === "missing")).toBe(true);
  });

  it("validates scripts and creates projects from text or a .md upload", async () => {
    await authed("post", "/projects").send({ script: "too short" }).expect(400);
    await authed("post", "/projects").send({}).expect(400);
    await authed("post", "/projects").attach("file", Buffer.from(SCRIPT), "evil.exe").expect(400);
    const a = await authed("post", "/projects").send({ script: SCRIPT }).expect(201);
    expect(a.body).toMatchObject({ title: "HTTP Test Video", status: "parsed", awaitingGate: null, nextStage: "plan" });
    expect(a.body.meta.beats).toEqual(["Hook", "Middle", "End"]);
    const b = await authed("post", "/projects").attach("file", Buffer.from(SCRIPT), "script.md").expect(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it("plans, keeps narration immutable, and gates approvals", async () => {
    const created = await authed("post", "/projects").send({ script: SCRIPT }).expect(201);
    const id = created.body.id as string;

    const est = (await authed("get", `/projects/${id}/estimate`).expect(200)).body;
    expect(est.basedOn).toBe("script");
    expect(est.total).toBeGreaterThan(0);

    await authed("post", `/projects/${id}/plan`).expect(201);
    await waitFor("planned", async () => (await authed("get", `/projects/${id}`)).body.status === "planned");
    const proj = (await authed("get", `/projects/${id}`)).body;
    expect(proj.awaitingGate).toBe("plan_approved");

    const scenes = (await authed("get", `/projects/${id}/scenes`).expect(200)).body as Array<{ id: string; narration: string; visual: string }>;
    expect(scenes.length).toBeGreaterThan(3);

    // narration can never be edited
    await authed("patch", `/scenes/${scenes[0].id}`).send({ narration: "rewritten" }).expect(400);
    const ok = await authed("patch", `/scenes/${scenes[0].id}`).send({ visual: "A lantern glows beside a quiet blue window" }).expect(200);
    expect(ok.body.visual).toMatch(/lantern/);
    expect(ok.body.narration).toBe(scenes[0].narration);

    await authed("post", `/projects/${id}/approve/images_approved`).expect(409); // wrong gate for this state
    await authed("post", `/projects/${id}/approve/nonsense`).expect(400);
    const approved = await authed("post", `/projects/${id}/approve/plan_approved`).expect(201);
    expect(approved.body.status).toBe("plan_approved");
    expect((await authed("get", `/projects/${id}/estimate`)).body.basedOn).toBe("plan");

    // refs -> served with HTTP Range support
    await authed("post", `/projects/${id}/run`).send({ to: "refs_ready" }).expect(201);
    await waitFor("refs_ready", async () => (await authed("get", `/projects/${id}`)).body.status === "refs_ready");
    const refs = (await authed("get", `/projects/${id}/refs`).expect(200)).body;
    expect(refs.anchors).toHaveLength(4);
    const full = await authed("get", refs.anchors[0].url).expect(200);
    expect(full.headers["content-type"]).toMatch(/image\/jpeg/);
    const part = await authed("get", refs.anchors[0].url).set("Range", "bytes=0-99").expect(206);
    expect(part.headers["content-range"]).toMatch(/^bytes 0-99\//);
    expect(part.body.length ?? part.text?.length).toBe(100);
    await authed("get", "/assets/not-a-uuid/content").expect(400);
    await authed("get", "/assets/00000000-0000-4000-8000-000000000000/content").expect(404);

    // the refs gate needs a selection
    await authed("post", `/projects/${id}/approve/refs_approved`).expect(409);
    await authed("post", `/projects/${id}/refs/select`).send({ anchorAssetId: refs.anchors[0].id }).expect(201);
    await authed("post", `/projects/${id}/approve/refs_approved`).expect(201);
  });

  it("plans from pasted JSON (no LLM): prompt, import, verbatim gate, then the normal flow", async () => {
    const id = (await authed("post", "/projects").send({ script: SCRIPT }).expect(201)).body.id as string;
    const prompt = (await authed("get", `/projects/${id}/plan/prompt`).expect(200)).body.prompt as string;
    expect(prompt).toContain("## Hook");
    expect(prompt).toContain("EXACT slice");

    const mk = (n: string, beat: string) => ({ beat, narration: n, visual: "A small figure sits beside a glowing candle in a dark blue room" });
    const good = [
      mk(SENTENCES.slice(0, 3).join(" "), "Hook"),
      mk(SENTENCES.slice(3, 6).join(" "), "Middle"),
      mk(SENTENCES.slice(6).join(" "), "End"),
    ];
    // altered narration is refused with an explanation
    const bad = await authed("post", `/projects/${id}/plan/import`).send({ text: JSON.stringify({ scenes: [{ ...good[0], narration: "Totally different words." }, good[1], good[2]] }) }).expect(400);
    expect(bad.body.message).toMatch(/word for word/);
    await authed("post", `/projects/${id}/plan/import`).send({ text: "not json" }).expect(400);
    expect((await authed("get", `/projects/${id}`)).body.status).toBe("parsed");

    const fence = "```";
    const reply = `Sure!\n${fence}json\n${JSON.stringify({ scenes: good })}\n${fence}`;
    const ok = await authed("post", `/projects/${id}/plan/import`).send({ text: reply }).expect(201);
    expect(ok.body.scenes).toBe(3);
    const p = (await authed("get", `/projects/${id}`)).body;
    expect(p).toMatchObject({ status: "planned", awaitingGate: "plan_approved" });
    expect((await authed("get", `/projects/${id}/verbatim`)).body.ok).toBe(true);
    // once approved, the plan can no longer be replaced
    await authed("post", `/projects/${id}/approve/plan_approved`).expect(201);
    await authed("post", `/projects/${id}/plan/import`).send({ text: JSON.stringify({ scenes: good }) }).expect(409);
  });

  it("streams project events over SSE", async () => {
    const created = await authed("post", "/projects").send({ script: SCRIPT }).expect(201);
    const id = created.body.id as string;
    const events: string[] = [];
    const req = http.get(`${baseUrl}/projects/${id}/events`, { headers: { Authorization: AUTH, Accept: "text/event-stream" } }, (res) => {
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
      res.setEncoding("utf8");
      res.on("data", (c: string) => events.push(c));
    });
    await new Promise((r) => setTimeout(r, 300));
    await authed("post", `/projects/${id}/plan`).expect(201);
    await waitFor("sse events", async () => events.join("").includes("event: job") && events.join("").includes("event: state"));
    req.destroy();
    expect(events.join("")).toMatch(/"stage":"plan"/);
  });

  it("enforces the budget cap with HTTP 402 and the numbers", async () => {
    const created = await authed("post", "/projects").send({ script: SCRIPT }).expect(201);
    const id = created.body.id as string;
    await authed("patch", `/projects/${id}/settings`).send({ maxUsdPerRun: 0.01 }).expect(200);
    const r = await authed("post", `/projects/${id}/plan`).expect(402);
    expect(r.body).toMatchObject({ code: "budget_exceeded", cap: 0.01 });
    expect(r.body.estimate).toBeGreaterThan(0.01);
    await authed("patch", `/projects/${id}/settings`).send({ style: "does-not-exist" }).expect(400);
    await authed("patch", `/projects/${id}/settings`).send({ maxUsdPerRun: -3 }).expect(400);
  });

  it("music library requires a licence note and a real audio file", async () => {
    const wav = path.join(dataDir, "tone.wav");
    await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=12", wav]);
    const bytes = await fs.readFile(wav);

    await authed("post", "/music").attach("file", bytes, "tone.wav").field("name", "No licence").expect(400);
    await authed("post", "/music").attach("file", bytes, "tone.wav").field("licenseNote", "   ").expect(400);
    await authed("post", "/music").attach("file", Buffer.from("not audio at all, just text pretending"), "x.mp3").field("licenseNote", "CC0").expect(400);
    await authed("post", "/music").attach("file", bytes, "tone.ogg").field("licenseNote", "CC0").expect(400);

    const ok = await authed("post", "/music").attach("file", bytes, "tone.wav").field("name", "Test tone").field("licenseNote", "Own work, CC0").expect(201);
    expect(ok.body).toMatchObject({ name: "Test tone", licenseNote: "Own work, CC0" });
    expect(ok.body.durationSec).toBeGreaterThan(11);
    expect((await authed("get", "/music").expect(200)).body).toHaveLength(1);

    const proj = (await authed("post", "/projects").send({ script: SCRIPT })).body;
    await authed("patch", `/projects/${proj.id}/settings`).send({ musicTrackId: ok.body.id }).expect(200);
    const del = await authed("delete", `/music/${ok.body.id}`).expect(200);
    expect(del.body.detachedFrom).toBe(1);
    expect((await authed("get", `/projects/${proj.id}`)).body.settings.musicTrackId).toBeNull();
  });
});
