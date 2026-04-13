# Logging and Audit Strategy

## Log types

### Application logs

- request lifecycle
- worker lifecycle
- queue events
- storage integration events

### Audit logs

- user-triggered transfer actions
- retries and cancellations
- configuration changes
- security-relevant actions

## IP-aware logging

For multi-user support, each request-level audit event should record:

- `ip`
- `x-forwarded-for`
- `user-agent`
- `actorId` when authentication exists
- `action`
- `resourceType`
- `resourceId`
- `timestamp`

## Important caution

Do not blindly trust forwarded headers in production.

- only trust `x-forwarded-for` when running behind a known proxy/load balancer
- otherwise prefer direct socket/real IP headers provided by infrastructure
- document trusted proxy policy before go-live

## Retention direction

- app logs: short-to-medium retention
- audit logs: longer retention with searchable indexing
- sensitive data should never be logged in raw form
