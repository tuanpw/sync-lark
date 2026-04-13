# Lark → MinIO Transfer Platform

Greenfield monorepo for a batch-oriented file transfer platform.

## Stack

- Backend API: Bun + Elysia
- Frontend Admin: Next.js + shadcn/ui-ready structure
- Worker: Bun runtime background worker
- Queue: Redis/BullMQ-oriented structure
- Metadata / checkpoints / audit: Postgres
- Object storage: MinIO
- Local infra: Docker Compose

## Directory layout

- `doc/` — architecture and planning docs
- `app/backend` — API and control plane
- `app/frontend` — admin UI
- `app/worker` — transfer data plane worker
- `app/shared` — shared contracts and types

## Local setup

1. Copy `.env.example` to `.env`
2. Start infra with `docker compose up -d`
3. Install dependencies with Bun once package choices are finalized
4. Run services independently:
   - `bun run dev:backend`
   - `bun run dev:frontend`
   - `bun run dev:worker`
