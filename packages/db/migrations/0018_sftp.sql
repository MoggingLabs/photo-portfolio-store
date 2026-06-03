-- M4 Wave 4 — F4.2 per-event SFTP accounts + upload dedup log.

CREATE TYPE "app"."sftp_account_status" AS ENUM ('active', 'disabled');

CREATE TABLE "app"."sftp_accounts" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"               uuid NOT NULL,                        -- refs events.id (cross-context)
  "system_username"        text NOT NULL,
  "public_key_fingerprint" text NOT NULL,
  "chroot_path"            text NOT NULL,
  "status"                 "app"."sftp_account_status" NOT NULL DEFAULT 'active',
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "last_login_at"          timestamp with time zone,
  "last_rotated_at"        timestamp with time zone
);

-- One account per event; usernames are globally unique.
CREATE UNIQUE INDEX "sftp_accounts_event_idx" ON "app"."sftp_accounts" ("event_id");
CREATE UNIQUE INDEX "sftp_accounts_username_idx" ON "app"."sftp_accounts" ("system_username");

CREATE TABLE "app"."sftp_uploads" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     uuid NOT NULL,
  "content_hash" text NOT NULL,
  "path"         text NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

-- Dedup: one ingest per (event, content hash) — resumed/duplicate uploads skip.
CREATE UNIQUE INDEX "sftp_uploads_event_hash_idx" ON "app"."sftp_uploads" ("event_id", "content_hash");
