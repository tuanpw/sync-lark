FROM oven/bun:1-alpine AS base
WORKDIR /app

# Copy workspace config
COPY package.json bun.lock tsconfig.base.json ./
COPY app/shared ./app/shared
COPY app/backend ./app/backend

# Install all workspace deps
RUN bun install --frozen-lockfile

EXPOSE 3001

CMD ["bun", "run", "app/backend/src/index.ts"]
