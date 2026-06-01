-- M4 Wave 2 — F4.9 print_lab_orders + F4.10 print_lab_webhook_events.
-- The print-fulfillment context: one lab order per commerce order (idempotent
-- on (lab_code, idempotency_key)) plus a deduped inbound webhook log.

CREATE TYPE "app"."print_lab_order_state" AS ENUM (
  'pending',
  'submitted',
  'in_production',
  'shipped',
  'delivered',
  'cancelled',
  'failed'
);

CREATE TABLE "app"."print_lab_orders" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id"                  uuid NOT NULL,                       -- refs orders.id (cross-context)
  "lab_code"                  text NOT NULL,
  "lab_order_id"              text,
  "state"                     "app"."print_lab_order_state" NOT NULL DEFAULT 'pending',
  "tracking_carrier"          text,
  "tracking_number"           text,
  "tracking_url"              text,
  "idempotency_key"           text NOT NULL,
  "attempts"                  integer NOT NULL DEFAULT 0,
  "next_retry_at"             timestamp with time zone,
  "needs_manual_intervention" boolean NOT NULL DEFAULT false,
  "last_status_at"            timestamp with time zone,
  "raw_state_json"            jsonb,
  "created_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                timestamp with time zone NOT NULL DEFAULT now()
);

-- A retried submit must map to the same lab order.
CREATE UNIQUE INDEX "print_lab_orders_lab_idem_idx"
  ON "app"."print_lab_orders" ("lab_code", "idempotency_key");
CREATE INDEX "print_lab_orders_order_idx" ON "app"."print_lab_orders" ("order_id");
CREATE INDEX "print_lab_orders_state_idx" ON "app"."print_lab_orders" ("state", "next_retry_at");

CREATE TABLE "app"."print_lab_webhook_events" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lab_code"        text NOT NULL,
  "webhook_id"      text NOT NULL,
  "received_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "signature_valid" boolean NOT NULL,
  "processed_at"    timestamp with time zone,
  "payload_json"    jsonb
);

-- Replay/dedup: a lab webhook id is processed at most once.
CREATE UNIQUE INDEX "print_lab_webhook_events_lab_webhook_idx"
  ON "app"."print_lab_webhook_events" ("lab_code", "webhook_id");
