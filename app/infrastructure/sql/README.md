# SQL schema

Initial Postgres schema for:

- users
- source connections
- managed sources
- import sessions
- import session items
- transfer jobs
- transfer job parts
- audit logs

Apply `0001_initial_schema.sql` with your migration tool of choice.

Recommended next step:

- add a proper migration runner
- add seed data for local development
- wire Bun backend/worker repositories to these tables
