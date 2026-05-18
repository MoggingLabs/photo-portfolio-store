-- F1.33 / F1.24 — biometric consent gate + selfie face search.
-- Adds tracking columns to app.consents for soft-bind + quota + TTL, plus a
-- consent_policy_versions allow-list table seeded at boot.

ALTER TABLE "app"."consents" ADD COLUMN "ip_hash" text;
ALTER TABLE "app"."consents" ADD COLUMN "user_agent" text;
ALTER TABLE "app"."consents" ADD COLUMN "searches_used" integer NOT NULL DEFAULT 0;
ALTER TABLE "app"."consents" ADD COLUMN "expires_at" timestamp with time zone;

CREATE INDEX "consents_expires_idx" ON "app"."consents" ("expires_at") WHERE "scope" = 'biometric';

-- Policy versions allow-list. Seeded at boot from apps/api policy-versions lib.
CREATE TABLE "app"."consent_policy_versions" (
  "version" text NOT NULL,
  "locale" text NOT NULL,
  "title" text NOT NULL,
  "body_markdown" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("version", "locale")
);
