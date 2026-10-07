# API Bizdin Auyl. Собирается из папки backend/ без остального монорепо:
#   docker build -t bizdin-auyl-api ./backend
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate && pnpm --version
WORKDIR /app

# Зависимости для сборки (TypeScript). Скрипты пакетов не нужны: нативных модулей нет.
FROM base AS build-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM build-deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Только рабочие зависимости.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    FILES_DIR=/data/files
WORKDIR /app
RUN mkdir -p /data/files && chown -R node:node /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json openapi.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health/ready >/dev/null || exit 1
CMD ["node", "dist/server.js"]
