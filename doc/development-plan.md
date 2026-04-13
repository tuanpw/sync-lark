# Development Plan

## Phase 1

- scaffold monorepo structure
- stand up local Postgres, Redis, MinIO with Docker Compose
- create backend API shell in Elysia
- create worker shell in Bun
- create Next.js admin shell

## Phase 2

- add DB schema for jobs, checkpoints, audit logs
- add queue producer/consumer flow
- integrate Lark file enumeration
- integrate MinIO multipart uploads

## Current starter status

- root Docker Compose for Postgres, Redis, MinIO
- SQL schema scaffold in `app/infrastructure/sql/0001_initial_schema.sql`
- shared API/data contracts in `app/shared/src/types.ts`
- backend route modules for sources/imports
- frontend dashboard shell consuming shared mock contracts

## Phase 3

- add verification and reconciliation
- add auth and role-aware UI
- add observability and alerting
- add cleanup for orphan multipart uploads

## Collaboration rules

- docs go in `doc/`
- runnable code goes in `app/`
- backend and worker changes must keep shared contracts in sync
- all operational behavior changes must update docs
