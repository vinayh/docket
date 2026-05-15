# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Tailwind for the backend HTML pages compiles here. devDeps include
# tailwindcss + @tailwindcss/cli; runtime image never sees them.
FROM oven/bun:1-alpine AS styles
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tokens.css ./
RUN bunx @tailwindcss/cli -i src/api/styles/input.css -o dist/backend.css --minify

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY --from=styles /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=8787
ENV MARGIN_DB_PATH=/data/margin.db

EXPOSE 8787

CMD ["sh", "-c", "bun src/db/migrate.ts && bun src/cli/index.ts serve"]
