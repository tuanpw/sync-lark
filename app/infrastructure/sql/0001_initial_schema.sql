CREATE TYPE source_mode AS ENUM ('oauth', 'managed', 'shared_link');
CREATE TYPE source_connection_status AS ENUM ('active', 'expired', 'revoked', 'error');
CREATE TYPE managed_source_status AS ENUM ('active', 'disabled', 'error');
CREATE TYPE import_session_status AS ENUM (
  'draft',
  'preview_ready',
  'queued',
  'running',
  'partial_failed',
  'completed',
  'failed',
  'cancelling',
  'cancelled'
);
CREATE TYPE transfer_job_status AS ENUM (
  'pending',
  'queued',
  'leased',
  'downloading',
  'uploading',
  'verifying',
  'completed',
  'retry_scheduled',
  'failed',
  'cancelled'
);
CREATE TYPE transfer_job_part_status AS ENUM (
  'pending',
  'uploading',
  'uploaded',
  'verifying',
  'completed',
  'retry_scheduled',
  'failed',
  'cancelled'
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE source_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  status source_connection_status NOT NULL,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  scope TEXT,
  external_account_id TEXT,
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE managed_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  status managed_source_status NOT NULL,
  credential_ref TEXT NOT NULL,
  workspace_id TEXT,
  workspace_name TEXT,
  description TEXT,
  last_validated_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE import_sessions (
  id TEXT PRIMARY KEY,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  source_mode source_mode NOT NULL,
  source_connection_id TEXT REFERENCES source_connections(id),
  managed_source_id TEXT REFERENCES managed_sources(id),
  source_reference TEXT,
  source_folder_id TEXT,
  source_folder_name TEXT,
  source_snapshot_version TEXT,
  status import_session_status NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  total_files INTEGER NOT NULL DEFAULT 0,
  discovered_files INTEGER NOT NULL DEFAULT 0,
  queued_files INTEGER NOT NULL DEFAULT 0,
  running_files INTEGER NOT NULL DEFAULT 0,
  completed_files INTEGER NOT NULL DEFAULT 0,
  failed_files INTEGER NOT NULL DEFAULT 0,
  cancelled_files INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  transferred_bytes BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  last_error TEXT,
  created_ip TEXT,
  created_user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE import_session_items (
  id TEXT PRIMARY KEY,
  import_session_id TEXT NOT NULL REFERENCES import_sessions(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL,
  parent_source_item_id TEXT,
  item_type TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  modified_at TIMESTAMPTZ,
  checksum TEXT,
  is_accessible BOOLEAN NOT NULL DEFAULT TRUE,
  skip_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE transfer_jobs (
  id TEXT PRIMARY KEY,
  import_session_id TEXT NOT NULL REFERENCES import_sessions(id) ON DELETE CASCADE,
  session_item_id TEXT NOT NULL REFERENCES import_session_items(id) ON DELETE CASCADE,
  status transfer_job_status NOT NULL,
  source_mode source_mode NOT NULL,
  source_file_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_download_ref TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT NOT NULL,
  target_bucket TEXT NOT NULL,
  target_object_key TEXT NOT NULL,
  is_multipart BOOLEAN NOT NULL DEFAULT FALSE,
  multipart_upload_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retry_count INTEGER NOT NULL DEFAULT 5,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_checkpoint_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  bytes_transferred BIGINT NOT NULL DEFAULT 0,
  checksum_expected TEXT,
  checksum_actual TEXT,
  verify_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(import_session_id, source_file_id)
);

CREATE TABLE transfer_job_parts (
  id TEXT PRIMARY KEY,
  transfer_job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  status transfer_job_part_status NOT NULL,
  byte_start BIGINT NOT NULL,
  byte_end BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  etag TEXT,
  checksum TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(transfer_job_id, part_number)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  import_session_id TEXT REFERENCES import_sessions(id),
  transfer_job_id TEXT REFERENCES transfer_jobs(id),
  source_mode source_mode,
  ip TEXT,
  forwarded_for TEXT,
  user_agent TEXT,
  request_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_import_sessions_user_id ON import_sessions(created_by_user_id);
CREATE INDEX idx_import_sessions_status ON import_sessions(status);
CREATE INDEX idx_import_sessions_created_at ON import_sessions(created_at DESC);
CREATE INDEX idx_transfer_jobs_session_id ON transfer_jobs(import_session_id);
CREATE INDEX idx_transfer_jobs_status ON transfer_jobs(status);
CREATE INDEX idx_transfer_jobs_worker_id ON transfer_jobs(worker_id);
CREATE INDEX idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_import_session_id ON audit_logs(import_session_id);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
