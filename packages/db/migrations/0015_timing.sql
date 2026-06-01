-- M4 Wave 3 — F4.6+ timing: per-event provider bindings + finish events.

CREATE TYPE "app"."timing_provider" AS ENUM ('runsignup', 'chronotrack', 'mylaps');

CREATE TABLE "app"."event_timing_bindings" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"              uuid NOT NULL,                          -- refs events.id (cross-context)
  "provider"              "app"."timing_provider" NOT NULL,
  "external_event_id"     text NOT NULL,                          -- the provider's race id
  "credentials_encrypted" text NOT NULL,                          -- envelope-encrypted; never returned
  "enabled"               boolean NOT NULL DEFAULT true,
  "sync_requested_at"     timestamp with time zone,
  "last_synced_at"        timestamp with time zone,
  "last_error"            text,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "event_timing_bindings_event_provider_idx"
  ON "app"."event_timing_bindings" ("event_id", "provider");
CREATE INDEX "event_timing_bindings_enabled_idx" ON "app"."event_timing_bindings" ("enabled");

CREATE TABLE "app"."finish_events" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"         uuid NOT NULL,
  "bib"              text NOT NULL,
  "split_name"       text NOT NULL DEFAULT 'finish',
  "gun_time_ms"      bigint,
  "chip_time_ms"     bigint,
  "recorded_at"      timestamp with time zone NOT NULL,
  "source"           text NOT NULL,
  "raw_payload_json" jsonb,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);

-- Idempotent ingest: one row per (event, bib, split).
CREATE UNIQUE INDEX "finish_events_event_bib_split_idx"
  ON "app"."finish_events" ("event_id", "bib", "split_name");
CREATE INDEX "finish_events_event_bib_idx" ON "app"."finish_events" ("event_id", "bib");
