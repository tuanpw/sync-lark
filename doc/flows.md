# Detailed Product Flows

## Source modes

### OAuth

1. User connects Lark account.
2. Backend stores source connection metadata.
3. User browses/selects a folder.
4. App resolves preview.
5. User starts import.

### Managed integration

1. Admin configures a shared integration source.
2. User selects an approved source.
3. User chooses a folder.
4. App resolves preview.
5. User starts import.

### Shared link

1. User pastes a public/shared link.
2. App validates and resolves a preview.
3. User confirms import.
4. App snapshots metadata and starts the session.

## Unified execution flow

1. Backend creates `import_session`.
2. Backend snapshots source metadata.
3. Backend creates one transfer job per file.
4. Queue dispatches jobs to workers.
5. Worker streams source → MinIO.
6. Worker verifies uploaded objects.
7. Frontend tracks progress by session and file.

## Retry flow

- Retry individual failed files.
- Retry all failed files in a session.
- Avoid restarting already completed work.

## Audit flow

- record actor, source mode, source reference, IP, session id, and action result
- store control-plane audit in Postgres
- keep application logs structured for external aggregation later
