# API Contracts

## Sources

### `GET /api/sources`

Returns import source mode options and source summaries.

### `GET /api/sources/connections`

Returns OAuth-backed source connections.

### `GET /api/sources/managed`

Returns managed integration sources.

### `POST /api/sources/oauth/connect`

Starts OAuth connection flow.

### `POST /api/sources/shared-link/validate`

Validates a shared/public link before preview/import.

## Imports

### `GET /api/imports`

Returns import sessions.

### `GET /api/imports/:id`

Returns one import session.

### `GET /api/imports/:id/jobs`

Returns transfer jobs for a session.

### `POST /api/imports/preview`

Input:

```json
{
  "mode": "shared_link",
  "sourceReference": "https://example.com/folder/demo"
}
```

Returns preview metadata, warnings, and estimated size/file counts.

### `POST /api/imports`

Creates an import session and returns the session record.

### `POST /api/imports/:id/retry-failed`

Requests retry for failed files within a session.

### `POST /api/imports/:id/cancel`

Requests cancellation of an active session.
