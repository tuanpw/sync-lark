# Architecture

## Final direction

- Transfer mode: batch
- Backend: Bun + Elysia
- Frontend: Next.js + shadcn/ui-ready admin shell
- Worker: separate Bun process
- Queue: BullMQ-compatible Redis queue
- Checkpoint and audit database: Postgres
- Object storage: MinIO
- Local infrastructure: Docker Compose

## Service boundaries

### `app/backend`

Control plane.

- exposes API for admin UI
- exposes transfer overview and future job control endpoints
- authenticates users in later phases
- records request logs and audit events

### `app/worker`

Data plane.

- consumes transfer jobs from queue
- streams files from Lark to MinIO
- handles multipart upload
- persists checkpoints and verification results

### `app/frontend`

Admin plane.

- dashboards and operations UI
- transfer monitoring
- audit and failure review UI

### `app/shared`

Shared contracts.

- event types
- job states
- config schema
- DTOs used by backend and worker

### `app/infrastructure`

Persistence and deployment assets.

- SQL migrations
- future repository wiring
- queue/bootstrap scripts

## Project layout

```txt
lark-minio-transfer-plan/
├─ app/
│  ├─ backend/
│  ├─ frontend/
│  ├─ infrastructure/
│  ├─ shared/
│  └─ worker/
├─ doc/
├─ docker-compose.yml
├─ package.json
└─ tsconfig.base.json
```

## Why this split

- backend stays responsive and does not run long transfer workloads
- worker can scale independently
- frontend remains a pure operator/admin surface
- shared contracts reduce drift between packages
- infrastructure assets stay versioned beside code without polluting runtime packages
