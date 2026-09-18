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
RUN bun run --cwd packages/ui build

# Go binaries — stdlib only, no CGO, static. A BUILDPLATFORM-pinned native
# stage so cross-builds (`--platform=linux/arm64`) stay cheap: TARGETOS/
# TARGETARCH fan out to the running platform's toolchain output.
#
# Two of them: the load generator, and the petstore that the load terminates at.
# The petstore is a separate process so that the control plane's event loop is
# not a term in the measurements the control plane records — see
# packages/go/internal/sut.
FROM golang:1.24-alpine AS gobuild
WORKDIR /src/packages/go
COPY packages/go/go.mod ./
COPY packages/go/internal ./internal
COPY packages/go/cmd ./cmd
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' \
      -o /out/gwtester-worker ./cmd/gwtester-worker \
 && GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' \
      -o /out/gwtester-sut ./cmd/gwtester-sut

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
# Go load generator — the spawn path looks for packages/go/bin/gwtester-worker
# (no .exe suffix on linux). This is the only supported generator and there is
# no fallback: without this binary the container starts but refuses every run,
# with the reason on the dashboard. There is no second generator to fall back
# to — the control plane generates no traffic of its own.
COPY --from=gobuild /out/gwtester-worker ./packages/go/bin/gwtester-worker
# Go petstore — spawned by the app on SUT_PORT. Default SUT_BACKEND is "go"; the
# image ships the binary so that default is satisfied — set SUT_BACKEND=ts to
# put the petstore back inside the Bun process.
COPY --from=gobuild /out/gwtester-sut ./packages/go/bin/gwtester-sut
# chown before VOLUME so a fresh named volume inherits bun-owned /app/data.
# A volume that already has content is mounted verbatim and never re-seeded —
# docker-entrypoint.sh is what covers that case.
RUN mkdir -p /app/data && chown -R bun:bun /app
ENV PORT=8080
ENV SUT_PORT=8081
# 8080 is the dashboard and control API; 8081 is the backend under test. The
# gateway being measured is pointed at 8081, so it has to be reachable from
# wherever that gateway runs — it carries the same Basic-auth gate as 8080.
EXPOSE 8080 8081
VOLUME ["/app/data"]
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# Starts as root only long enough to chown /app/data; the server itself runs as
# `bun`. See docker-entrypoint.sh.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "packages/app/src/index.ts"]
