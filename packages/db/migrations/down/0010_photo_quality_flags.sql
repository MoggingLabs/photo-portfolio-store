-- Down migration for 0010_photo_quality_flags.

DROP INDEX IF EXISTS "app"."photos_phash_idx";
ALTER TABLE "app"."photos" DROP COLUMN IF EXISTS "phash";
ALTER TABLE "app"."photos" DROP COLUMN IF EXISTS "blur_score";
ALTER TABLE "app"."photos" DROP COLUMN IF EXISTS "quality_flags";
