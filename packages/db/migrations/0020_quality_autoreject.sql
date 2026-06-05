-- M5 F5.5 — quality auto-reject: a normalized 0-1 quality score on photos +
-- a per-photographer threshold/flag controlling whether below-threshold photos
-- are auto-rejected (hidden from buyers until the photographer overrides).

ALTER TABLE "app"."photos"
  ADD COLUMN "quality_score"           numeric(3, 2),
  ADD COLUMN "auto_rejected"           boolean NOT NULL DEFAULT false,
  ADD COLUMN "rejection_overridden_at" timestamp with time zone;

CREATE TABLE "app"."photographer_settings" (
  "photographer_user_id"   uuid PRIMARY KEY,                          -- refs users.id (cross-context)
  "quality_filter_enabled" boolean NOT NULL DEFAULT false,
  "quality_threshold"      numeric(3, 2) NOT NULL DEFAULT 0.50,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now()
);
