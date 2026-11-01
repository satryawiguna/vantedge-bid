# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so a source-only change does not invalidate the
# dependency layer.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini reaps zombies and forwards SIGTERM, which is what lets the worker finish
# its current job on shutdown instead of being killed mid-transaction.
RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The migrator reads the .sql files at runtime; they are not compiled in.
COPY db ./db

# Local-disk object storage lives here (the api and worker mount one volume at
# this path). It is created and owned by `node` in the image so that a named
# volume inherits that ownership on first mount; otherwise the non-root user
# cannot write to it.
RUN mkdir -p /data/storage && chown node:node /data/storage

USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
