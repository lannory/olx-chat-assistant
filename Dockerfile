# syntax=docker/dockerfile:1

# ---- build: compile TypeScript, then keep only production deps ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 ships prebuilt binaries; build tools are a fallback for exotic platforms.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DB_PATH=/app/data/olx-bot.db \
    TEMPLATES_PATH=/app/config/templates.json \
    ADVERTS_CONFIG_PATH=/app/config/adverts.config.json \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node receives SIGTERM directly (exec form) → graceful shutdown.
CMD ["node", "dist/worker.js"]
