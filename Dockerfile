# Build the React dashboard first.
# The UI compiles @apigw/shared from source (see packages/ui/vite.config.ts),
# so this stage needs packages/shared even though it never builds it separately.
FROM node:22-alpine AS ui
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN npm ci -w @apigw/ui --include-workspace-root=false
COPY packages/shared packages/shared
COPY packages/ui packages/ui
RUN npm run build -w @apigw/ui

# Build the app (TS → JS), prune to prod deps
FROM node:22-alpine AS server
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
RUN npm ci --workspaces --include-workspace-root=false
COPY packages/shared packages/shared
COPY packages/app packages/app
RUN npm run build -w @apigw/shared && npm run build -w @apigw/app && npm prune --omit=dev

# Runtime
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# su-exec lets the entrypoint drop to `node` after repairing volume ownership
RUN apk add --no-cache su-exec
COPY --from=server /repo/node_modules ./node_modules
COPY --from=server /repo/packages/app/dist ./dist
COPY packages/app/package.json ./
# workspace-scoped shared package: materialize the real compiled output
RUN rm -rf /app/node_modules/@apigw/shared
COPY packages/shared/package.json /app/node_modules/@apigw/shared/package.json
COPY --from=server /repo/packages/shared/dist /app/node_modules/@apigw/shared/dist
# UI bundle baked in, served from the same process
COPY --from=ui /repo/packages/ui/dist ./dist/public
# chown before VOLUME so a fresh named volume inherits node-owned /app/data.
# A volume that already has content is mounted verbatim and never re-seeded —
# docker-entrypoint.sh is what covers that case.
RUN mkdir -p /app/data && chown -R node:node /app
ENV PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# Starts as root only long enough to chown /app/data; the server itself runs as
# `node`. See docker-entrypoint.sh.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
