# Build the React dashboard first
FROM node:22-alpine AS ui
WORKDIR /repo
COPY package.json tsconfig.base.json ./
COPY packages/ui/package.json packages/ui/
RUN npm install -w @apigw/ui --include-workspace-root=false
COPY packages/ui packages/ui
RUN npm run build -w @apigw/ui

# Build the app (TS → JS), prune to prod deps
FROM node:22-alpine AS server
WORKDIR /repo
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
RUN npm install --workspaces --include-workspace-root=false
COPY packages/shared packages/shared
COPY packages/app packages/app
RUN npm run build -w @apigw/shared && npm run build -w @apigw/app && npm prune --omit=dev

# Runtime
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server /repo/node_modules ./node_modules
COPY --from=server /repo/packages/app/dist ./dist
COPY packages/app/package.json ./
# workspace-scoped shared package: materialize the real compiled output
RUN rm -rf /app/node_modules/@apigw/shared
COPY packages/shared/package.json /app/node_modules/@apigw/shared/package.json
COPY --from=server /repo/packages/shared/dist /app/node_modules/@apigw/shared/dist
# UI bundle baked in, served from the same process
COPY --from=ui /repo/packages/ui/dist ./dist/public
RUN mkdir -p /app/data && chown -R node:node /app
ENV PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
USER node
CMD ["node", "dist/index.js"]
