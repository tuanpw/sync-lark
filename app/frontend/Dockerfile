FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY app/shared ./app/shared
COPY app/frontend ./app/frontend

RUN bun install --frozen-lockfile

ARG NEXT_PUBLIC_API_BASE_URL=http://37.27.131.100:3001/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN bun run --cwd app/frontend build

FROM oven/bun:1-alpine AS runner
WORKDIR /app

COPY --from=builder /app/app/frontend/.next/standalone ./
COPY --from=builder /app/app/frontend/.next/static ./app/frontend/.next/static
COPY --from=builder /app/app/frontend/public ./app/frontend/public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "app/frontend/server.js"]
