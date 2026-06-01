-- Down migration for 0017_participant_notifications.

DROP TABLE IF EXISTS "app"."notification_suppressions";
DROP TABLE IF EXISTS "app"."participant_notifications";
ALTER TABLE "app"."participants" DROP COLUMN IF EXISTS "locale";
ALTER TABLE "app"."participants" DROP COLUMN IF EXISTS "sms_opt_in";
DROP TYPE IF EXISTS "app"."notification_status";
DROP TYPE IF EXISTS "app"."notification_channel";
