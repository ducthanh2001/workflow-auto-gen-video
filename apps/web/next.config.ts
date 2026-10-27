import path from "node:path";
import type { NextConfig } from "next";

// The browser only ever talks to this origin. /api/* is proxied to the NestJS API, which keeps the
// provider keys; the HTTP Basic credentials the browser holds are forwarded with each request.
const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";

const config: NextConfig = {
  // The Docker image sets NEXT_STANDALONE=1 (Linux). Locally `next build` skips it, because
  // copying pnpm's symlinked node_modules into .next/standalone fails on Windows.
  ...(process.env.NEXT_STANDALONE === "1"
    ? { output: "standalone" as const, outputFileTracingRoot: path.join(__dirname, "../../") }
    : {}),
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/:path*` }];
  },
  experimental: {
    // long-lived SSE connections go through the rewrite
    proxyTimeout: 60 * 60 * 1000,
  },
};

export default config;
