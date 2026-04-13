FROM oven/bun:1-alpine AS base
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY app/shared ./app/shared
COPY app/worker ./app/worker

RUN bun install --frozen-lockfile

CMD ["bun", "run", "app/worker/src/index.ts"]
