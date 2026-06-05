-- M4 Wave 4 — F4.4 Google Drive / Dropbox folder imports.
-- The OAuth connection lives per-org in integration_configs (type gdrive/dropbox);
-- cloud_imports binds a remote folder to an event and tracks sync progress;
-- cloud_import_files is a per-file resume state machine deduped on (event, hash).

CREATE TYPE "app"."cloud_import_provider" AS ENUM ('gdrive', 'dropbox');
CREATE TYPE "app"."cloud_import_status" AS ENUM ('pending', 'running', 'completed', 'failed');
CREATE TYPE "app"."cloud_import_file_status" AS ENUM ('pending', 'imported', 'failed');

CREATE TABLE "app"."cloud_imports" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"              uuid NOT NULL,                              -- refs events.id (cross-context)
  "org_id"                uuid NOT NULL,                              -- denormalized from events.org_id
  "photographer_user_id"  uuid NOT NULL,                             -- refs users.id; used for photos insert
  "provider"              "app"."cloud_import_provider" NOT NULL,
  "remote_folder_id"      text NOT NULL,
  "status"                "app"."cloud_import_status" NOT NULL DEFAULT 'pending',
  "total_files"           integer,                                   -- null until first folder listing
  "imported_files"        integer NOT NULL DEFAULT 0,
  "failed_files"          integer NOT NULL DEFAULT 0,
  "started_at"            timestamp with time zone,
  "completed_at"          timestamp with time zone,
  "last_error"            text,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now()
);

-- The worker sweep selects pending/running imports; events list their imports.
CREATE INDEX "cloud_imports_status_idx" ON "app"."cloud_imports" ("status");
CREATE INDEX "cloud_imports_event_idx" ON "app"."cloud_imports" ("event_id");

CREATE TABLE "app"."cloud_import_files" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cloud_import_id"  uuid NOT NULL,                                  -- refs cloud_imports.id (cross-context)
  "remote_file_id"   text NOT NULL,
  "content_hash"     text NOT NULL,                                  -- namespaced provider hash / fileid fallback
  "name"             text NOT NULL,                                  -- listing snapshot (avoid re-list each tick)
  "content_type"     text NOT NULL,
  "size_bytes"       bigint,                                         -- null only on rows pre-failed for missing size
  "photo_id"         uuid,                                           -- set after photos row + ingest enqueue
  "status"           "app"."cloud_import_file_status" NOT NULL DEFAULT 'pending',
  "attempts"         integer NOT NULL DEFAULT 0,                     -- bounded retry on transient failures
  "error"            text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

-- Dedup / resume: one row per (import, content hash); also serves status scans.
CREATE UNIQUE INDEX "cloud_import_files_import_hash_idx" ON "app"."cloud_import_files" ("cloud_import_id", "content_hash");
