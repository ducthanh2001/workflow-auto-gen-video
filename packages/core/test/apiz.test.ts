import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ApizImage } from "../src/providers/apiz";
import { ProviderError } from "../src/providers/http";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const KEY = "sk-test-secret-key-123456";

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  body?: Record<string, unknown>;
}

describe("ApizImage (against a local stand-in for the gateway)", () => {
  let server: http.Server;
  let base: string;
  let genSeen: Seen = {};
  let editSeen: { method?: string; url?: string; auth?: string; ctype?: string; raw?: string } = {};
  let dlAuth: string | undefined;
  let mode: "url" | "b64" | "blocked" | "nourl" | "badscheme" = "url";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/v1/images/edits") {
          const raw = Buffer.concat(chunks);
          editSeen = { method: req.method, url: req.url, auth: req.headers.authorization, ctype: String(req.headers["content-type"] ?? ""), raw: raw.toString("latin1") };
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ data: [{ url: `${base}/files/pic.jpeg`, mime_type: "image/jpeg" }] }));
        }
        if (req.url === "/v1/images/generations") {
          genSeen = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
          res.setHeader("content-type", "application/json");
          if (mode === "blocked") {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: { message: `Your request was rejected by the safety system. key ${KEY}` } }));
          }
          if (mode === "b64") return res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
          if (mode === "nourl") return res.end(JSON.stringify({ data: [] }));
          if (mode === "badscheme") return res.end(JSON.stringify({ data: [{ url: "file:///etc/passwd" }] }));
          return res.end(JSON.stringify({ data: [{ url: `${base}/files/pic.jpeg`, mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 1 } }));
        }
        if (req.url === "/files/pic.jpeg") {
          dlAuth = req.headers.authorization;
          res.setHeader("content-type", "image/jpeg");
          return res.end(PNG);
        }
        res.statusCode = 404;
        res.end("nope");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const make = (extra: Partial<ConstructorParameters<typeof ApizImage>[0]> = {}) =>
    new ApizImage({ apiKey: KEY, model: "gpt-image-2.5", usdPerImage: 0.0144, baseUrl: `${base}/v1`, ...extra });
  const req = { prompt: "a quiet room", refs: [], aspect: "16:9" as const };
  const withRef = { prompt: "a hero in a room", refs: [{ mime: "image/png", data: Buffer.from("REFERENCE-BYTES") }], aspect: "16:9" as const };

  it("needs a key and a model", () => {
    expect(() => new ApizImage({ apiKey: "", model: "m", usdPerImage: 0 })).toThrow(/APIZ_API_KEY/);
    expect(() => new ApizImage({ apiKey: "k", model: "", usdPerImage: 0 })).toThrow(/APIZ_IMAGE_MODEL/);
  });

  it("sends the key as a Bearer token with model, prompt and a 16:9 size, and downloads the picture", async () => {
    mode = "url";
    const out = await make().generate(req);
    expect(genSeen.method).toBe("POST");
    expect(genSeen.auth).toBe(`Bearer ${KEY}`);
    expect(genSeen.body).toEqual({ model: "gpt-image-2.5", prompt: "a quiet room", size: "1024x576" });
    expect(out.image.equals(PNG)).toBe(true);
    expect(out.mime).toBe("image/jpeg");
    expect(out.costUsd).toBe(0.0144);
  });

  it("never sends the key to the image download host", async () => {
    mode = "url";
    dlAuth = "unset";
    await make().generate(req);
    expect(dlAuth).toBeUndefined();
  });

  it("takes one reference picture per call", () => {
    const p = make();
    expect(p.acceptsRefs).toBe(true);
    expect(p.maxRefs).toBe(1);
  });

  it("with a reference picture it calls /images/edits as multipart (model, prompt, image) and keeps the key private", async () => {
    mode = "url";
    dlAuth = "unset";
    genSeen = {};
    editSeen = {};
    const out = await make().generate({ ...withRef, refs: [...withRef.refs, { mime: "image/jpeg", data: Buffer.from("SECOND-IGNORED") }] });
    expect(genSeen.url).toBeUndefined(); // the JSON route was not used
    expect(editSeen.method).toBe("POST");
    expect(editSeen.auth).toBe(`Bearer ${KEY}`);
    expect(editSeen.ctype).toMatch(/^multipart\/form-data; boundary=/);
    const raw = editSeen.raw ?? "";
    expect(raw).toMatch(/name="model"\r\n\r\ngpt-image-2\.5/);
    expect(raw).toMatch(/name="prompt"\r\n\r\na hero in a room/);
    expect(raw).toMatch(/name="image"; filename="reference\.png"/);
    expect(raw).toContain("REFERENCE-BYTES");
    expect(raw).not.toContain("SECOND-IGNORED"); // only the first picture is sent
    expect(dlAuth).toBeUndefined();
    expect(out.image.equals(PNG)).toBe(true);
    expect(out.costUsd).toBe(0.0144);
  });

  it("re-encodes a reference that is over the size limit", async () => {
    mode = "url";
    editSeen = {};
    const sharp = (await import("sharp")).default;
    // noisy picture: hard to compress, so the PNG is bigger than 4.5 MB
    const w = 2400, h = 1600;
    const noise = Buffer.alloc(w * h * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const big = await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(big.length).toBeGreaterThan(4_500_000);
    await make().generate({ ...withRef, refs: [{ mime: "image/png", data: big }] });
    expect(editSeen.raw).toMatch(/filename="reference\.jpg"/);
    expect((editSeen.raw ?? "").length).toBeLessThan(5_000_000);
  });

  it("uses the configured size", async () => {
    mode = "url";
    await make({ size: "1536x864" }).generate(req);
    expect(genSeen.body?.size).toBe("1536x864");
  });

  it("accepts base64 pictures", async () => {
    mode = "b64";
    const out = await make().generate(req);
    expect(out.image.equals(PNG)).toBe(true);
    expect(out.mime).toBe("image/png");
  });

  it("marks safety refusals as blocked, does not retry them, and keeps the key out of the message", async () => {
    mode = "blocked";
    const err = await make().generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("blocked");
    expect(err.retriable).toBe(false);
    expect(err.message).not.toContain(KEY);
  });

  it("rejects an answer without a picture and an unsafe url scheme", async () => {
    mode = "nourl";
    await expect(make().generate(req)).rejects.toThrow(/no image/);
    mode = "badscheme";
    await expect(make().generate(req)).rejects.toThrow(/unsupported url scheme/);
  });
});
