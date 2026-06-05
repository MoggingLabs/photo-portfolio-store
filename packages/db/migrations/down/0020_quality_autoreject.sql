-- Down migration for 0020_quality_autoreject.

DROP TABLE IF EXISTS "app"."photographer_settings";
ALTER TABLE "app"."photos"
  DROP COLUMN IF EXISTS "rejection_overridden_at",
  DROP COLUMN IF EXISTS "auto_rejected",
  DROP COLUMN IF EXISTS "quality_score";
