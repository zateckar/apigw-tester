# Build the React dashboard first.
# The UI compiles @apigw/shared from source (see packages/ui/vite.config.ts),
# so this stage needs packages/shared even though it never builds it separately.
FROM oven/bun:1.4-alpine AS ui
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/ui packages/ui
RUN bun run build -w @apigw/ui

# App stage: no emit step — the app is TypeScript run directly by Bun at
# runtime. Only the workspace manifests + source need to ship.
FROM oven/bun:1.4-alpine AS server
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
RUN bun install --frozen-lockfile --production
COPY packages/shared packages/shared
COPY packages/app packages/app

# Runtime
FROM oven/bun:1.4-alpine
WORKDIR /app
# su-exec lets the entrypoint drop to `bun` after repairing volume ownership
RUN apk add --no-cache su-exec
COPY --from=server /repo/node_modules ./node_modules
COPY --from=server /repo/packages ./packages
COPY package.json ./
# UI bundle baked in, served from the same process
COPY --from=ui /repo/packages/ui/dist ./packages/app/public
# chown before VOLUME so a fresh named volume inherits bun-owned /app/data.
# A volume that already has content is mounted verbatim and never re-seeded —
# docker-entrypoint.sh is what covers that case.
RUN mkdir -p /app/data && chown -R bun:bun /app
ENV PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# Starts as root only long enough to chown /app/data; the server itself runs as
# `bun`. See docker-entrypoint.sh.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "packages/app/src/index.ts"]
