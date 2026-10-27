/** HTTP helper for providers: retries, 429 Retry-After, and no secrets in errors. */

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retriable = false,
    public readonly kind: "http" | "blocked" | "invalid" | "timeout" = "http",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** label used in error messages, e.g. "elevenlabs.tts" */
  label: string;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function parseRetryAfter(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

/** Strip anything that looks like a key/token from a string before it is logged or stored. */
export function redact(s: string): string {
  return s
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/(AIza[0-9A-Za-z_-]{20,})/g, "[redacted]")
    .replace(/([?&](?:key|api_key|token|signature|X-Amz-Signature)=)[^&\s"]+/gi, "$1[redacted]");
}

export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : undefined;
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: init.signal ?? ctrl.signal });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.ok) return res;

      const body = redact((await res.text().catch(() => "")).slice(0, 600));
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt === retries) {
        throw new ProviderError(`${opts.label} failed: HTTP ${res.status} ${body}`, res.status, retriable);
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const backoff = Math.min(max, base * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(max, retryAfter ?? backoff));
      lastErr = new ProviderError(`${opts.label}: HTTP ${res.status}`, res.status, true);
    } catch (e) {
      if (e instanceof ProviderError) {
        if (!e.retriable || attempt === retries) throw e;
        lastErr = e;
        continue;
      }
      const aborted = (e as Error).name === "AbortError";
      if (attempt === retries) {
        throw new ProviderError(`${opts.label} ${aborted ? "timed out" : "network error: " + redact((e as Error).message)}`, undefined, true, aborted ? "timeout" : "http");
      }
      lastErr = e;
      await sleep(Math.min(max, base * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError(`${opts.label} failed`);
}
