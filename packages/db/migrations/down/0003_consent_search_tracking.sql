-- Reverses 0003_consent_search_tracking.sql

DROP TABLE IF EXISTS "app"."consent_policy_versions";

DROP INDEX IF EXISTS "app"."consents_expires_idx";

ALTER TABLE "app"."consents" DROP COLUMN IF EXISTS "expires_at";
ALTER TABLE "app"."consents" DROP COLUMN IF EXISTS "searches_used";
ALTER TABLE "app"."consents" DROP COLUMN IF EXISTS "user_agent";
ALTER TABLE "app"."consents" DROP COLUMN IF EXISTS "ip_hash";
