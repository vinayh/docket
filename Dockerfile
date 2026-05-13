# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle

ENV NODE_ENV=production
ENV PORT=8787
ENV MARGIN_DB_PATH=/data/margin.db

EXPOSE 8787

CMD ["sh", "-c", "bun src/db/migrate.ts && bun src/cli/index.ts serve"]
