# syntax=docker/dockerfile:1
# One Dockerfile, three runtime targets: api, worker, web.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
# ffmpeg 7.x static build with libx264, libass, xfade, zoompan, loudnorm, sidechaincompress (checked by `vp-doctor`)
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:7.1 /ffprobe /usr/local/bin/ffprobe
WORKDIR /app

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm run build:packages && pnpm --filter @vp/api build && pnpm --filter @vp/worker build
# Next bakes rewrites into the build, so the API address must be known here (the compose service name).
ARG API_URL=http://api:4000
ENV NEXT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1 API_URL=$API_URL
RUN pnpm --filter @vp/web build

# ---- api -------------------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app /app
COPY config ./config
COPY assets ./assets
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

# ---- worker (same image contents; includes ffmpeg for rendering) -------------------------
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app /app
COPY config ./config
COPY assets ./assets
RUN mkdir -p /data && chown -R node:node /data
USER node
CMD ["node", "apps/worker/dist/main.js"]

# ---- web ---------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
