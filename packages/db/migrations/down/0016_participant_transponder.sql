-- Down migration for 0016_participant_transponder.

DROP INDEX IF EXISTS "app"."participants_event_transponder_idx";
ALTER TABLE "app"."participants" DROP COLUMN IF EXISTS "transponder_id";
