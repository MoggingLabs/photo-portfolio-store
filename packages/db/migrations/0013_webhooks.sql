-- M4 Wave 1 — F4.11 outbound webhooks: subscriptions + delivery log.
-- HMAC-signed deliveries with retry/backoff, circuit-breaking, and a
-- per-attempt delivery log.

CREATE TYPE "app"."webhook_delivery_status" AS ENUM ('pending', 'delivered', 'failed', 'retrying');

CREATE TABLE "app"."webhook_subscriptions" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"                uuid NOT NULL,                          -- refs organizations.id (cross-context)
  "target_url"            text NOT NULL,
  -- Envelope-encrypted HMAC secret (never returned after creation).
  "secret_encrypted"      text NOT NULL,
  "event_types"           text[] NOT NULL,
  "enabled"               boolean NOT NULL DEFAULT true,
  "disabled_reason"       text,
  "consecutive_failures"  integer NOT NULL DEFAULT 0,
  "cooldown_until"        timestamp with time zone,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "webhook_subscriptions_org_idx" ON "app"."webhook_subscriptions" ("org_id");

CREATE TABLE "app"."webhook_deliveries" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id"        uuid NOT NULL REFERENCES "app"."webhook_subscriptions" ("id") ON DELETE CASCADE,
  "event_id"               uuid NOT NULL,                         -- X-Webhook-Id (UUIDv7); receivers may dedupe
  "event_type"             text NOT NULL,
  "attempt"                integer NOT NULL DEFAULT 1,
  "status"                 "app"."webhook_delivery_status" NOT NULL DEFAULT 'pending',
  "http_status"            integer,
  "response_body_excerpt"  text,
  "scheduled_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "delivered_at"           timestamp with time zone,
  "next_retry_at"          timestamp with time zone,
  "payload_json"           jsonb
);

CREATE INDEX "webhook_deliveries_sub_idx"
  ON "app"."webhook_deliveries" ("subscription_id", "scheduled_at");
