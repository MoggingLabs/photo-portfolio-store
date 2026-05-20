-- F2.1 (bundles + pricing rules) and F2.8 (payout ledger).
-- Also adds refund_requests required by F2.6.
-- All objects live in the "app" schema.

-- ------------------------------------------------------------------ enums --

CREATE TYPE "app"."bundle_kind" AS ENUM ('bib', 'foto_flat', 'custom');

CREATE TYPE "app"."pricing_rule_scope" AS ENUM ('global', 'event', 'bundle', 'photographer');

CREATE TYPE "app"."pricing_rule_kind" AS ENUM (
  'qty_discount',
  'time_window',
  'pre_event',
  'tier_uplift'
);

CREATE TYPE "app"."ledger_direction" AS ENUM ('debit', 'credit');

CREATE TYPE "app"."ledger_kind" AS ENUM (
  'sale',
  'platform_fee',
  'stripe_fee',
  'refund',
  'payout',
  'adjustment'
);

CREATE TYPE "app"."payout_status" AS ENUM ('pending', 'sent', 'paid', 'failed');

CREATE TYPE "app"."refund_request_status" AS ENUM ('pending', 'approved', 'denied', 'processed');

-- ----------------------------------------------------------------- tables --

-- bundles
-- selector shape by kind:
--   bib       => { "bib": "<value>" }
--   foto_flat => { "all": true }
--   custom    => { "photoIds": ["<uuid>", ...] }
-- license_tier_id uses a same-file FK (license_tiers is in this schema).
-- event_id is a cross-context reference to events.id (no FK constraint).

CREATE TABLE "app"."bundles" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"         uuid NOT NULL,                                           -- refs events.id (cross-context)
  "kind"             "app"."bundle_kind" NOT NULL,
  "selector"         jsonb NOT NULL DEFAULT '{}',
  "base_price_cents" integer NOT NULL,
  "currency"         text NOT NULL,
  "license_tier_id"  uuid NOT NULL REFERENCES "app"."license_tiers" ("id"),
  "active"           boolean NOT NULL DEFAULT true,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);

-- bundle_items (materialized bundle membership)
-- photo_id is a cross-context reference to photos.id (no FK constraint).

CREATE TABLE "app"."bundle_items" (
  "bundle_id" uuid NOT NULL REFERENCES "app"."bundles" ("id") ON DELETE CASCADE,
  "photo_id"  uuid NOT NULL,                                                  -- refs photos.id (cross-context)
  PRIMARY KEY ("bundle_id", "photo_id")
);

-- pricing_rules
-- params shape examples:
--   tier_uplift  => { "tierCode": "commercial", "multiplier": 2.5 }
--   qty_discount => { "minQty": 5, "pct": 0.1 }
--   time_window  => { "pct": 0.15 }
--   pre_event    => { "pct": 0.20 }

CREATE TABLE "app"."pricing_rules" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope"      "app"."pricing_rule_scope" NOT NULL,
  "kind"       "app"."pricing_rule_kind" NOT NULL,
  "params"     jsonb NOT NULL DEFAULT '{}',
  "priority"   integer NOT NULL DEFAULT 0,
  "starts_at"  timestamp with time zone,
  "ends_at"    timestamp with time zone,
  "active"     boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- pricing_rule_targets
-- target_type values: 'event' | 'bundle' | 'photographer' | 'tier'
-- target_id is always a uuid referencing the appropriate entity cross-context.

CREATE TABLE "app"."pricing_rule_targets" (
  "rule_id"     uuid NOT NULL REFERENCES "app"."pricing_rules" ("id") ON DELETE CASCADE,
  "target_type" text NOT NULL,
  "target_id"   uuid NOT NULL,
  PRIMARY KEY ("rule_id", "target_type", "target_id")
);

-- payout_accounts
-- One row per photographer. status lifecycle:
--   'pending'     — row created; Stripe Connect onboarding not started
--   'pending_kyc' — Stripe account exists; KYC requirements outstanding
--   'active'      — charges and payouts enabled
--   'restricted'  — Stripe flagged; limited capability
--   'rejected'    — onboarding permanently blocked
-- photographer_id refs users.id (cross-context, no FK).

CREATE TABLE "app"."payout_accounts" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "photographer_id"   uuid NOT NULL UNIQUE,                                   -- refs users.id (cross-context)
  "stripe_account_id" text UNIQUE,
  "country"           text NOT NULL,
  "currency"          text NOT NULL,
  "charges_enabled"   boolean NOT NULL DEFAULT false,
  "payouts_enabled"   boolean NOT NULL DEFAULT false,
  "requirements"      jsonb NOT NULL DEFAULT '{}',
  "status"            text NOT NULL DEFAULT 'pending',
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

-- payouts
-- One record = one bank transfer for a billing period.
-- payout_account_id is a same-file FK to payout_accounts.

CREATE TABLE "app"."payouts" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "payout_account_id"  uuid NOT NULL REFERENCES "app"."payout_accounts" ("id"),
  "period_start"       date NOT NULL,
  "period_end"         date NOT NULL,
  "gross_cents"        integer NOT NULL,
  "fees_cents"         integer NOT NULL,
  "net_cents"          integer NOT NULL,
  "currency"           text NOT NULL,
  "stripe_transfer_id" text,
  "status"             "app"."payout_status" NOT NULL DEFAULT 'pending',
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "sent_at"            timestamp with time zone,
  "paid_at"            timestamp with time zone
);

-- ledger_entries
-- Immutable double-entry ledger. amount_cents is always positive; direction
-- encodes the sign. Partial unique index prevents double-posting per order.
-- account_id and payout_id are same-file FKs.
-- order_id refs orders.id (cross-context, no FK).
-- refund_id refs refund_requests.id (cross-context, no FK).

CREATE TABLE "app"."ledger_entries" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"   uuid NOT NULL REFERENCES "app"."payout_accounts" ("id"),
  "order_id"     uuid,                                                        -- refs orders.id (cross-context)
  "refund_id"    uuid,                                                        -- refs refund_requests.id (cross-context)
  "payout_id"    uuid REFERENCES "app"."payouts" ("id"),
  "direction"    "app"."ledger_direction" NOT NULL,
  "amount_cents" integer NOT NULL CHECK ("amount_cents" > 0),
  "currency"     text NOT NULL,
  "kind"         "app"."ledger_kind" NOT NULL,
  "memo"         text NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

-- refund_requests
-- Buyer-initiated refund requests. requested_items is an array of
-- order_item ids or photo ids; empty array implies full-order refund.
-- order_id is a same-file FK to orders. buyer_id refs users.id (cross-context).

CREATE TABLE "app"."refund_requests" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id"         uuid NOT NULL REFERENCES "app"."orders" ("id") ON DELETE CASCADE,
  "buyer_id"         uuid,                                                    -- refs users.id (cross-context)
  "reason"           text NOT NULL,
  "requested_items"  jsonb NOT NULL DEFAULT '[]',
  "status"           "app"."refund_request_status" NOT NULL DEFAULT 'pending',
  "admin_note"       text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- indexes --

CREATE INDEX "bundles_event_active_idx" ON "app"."bundles" ("event_id", "active");

CREATE INDEX "pricing_rules_scope_active_idx" ON "app"."pricing_rules" ("scope", "active", "starts_at", "ends_at");

CREATE INDEX "pricing_rule_targets_target_idx" ON "app"."pricing_rule_targets" ("target_type", "target_id");

CREATE INDEX "payout_accounts_status_idx" ON "app"."payout_accounts" ("status");

CREATE INDEX "payouts_account_period_idx" ON "app"."payouts" ("payout_account_id", "period_end");

CREATE INDEX "ledger_entries_account_created_idx" ON "app"."ledger_entries" ("account_id", "created_at");

CREATE INDEX "ledger_entries_order_idx" ON "app"."ledger_entries" ("order_id");

CREATE UNIQUE INDEX "ledger_entries_dedupe_idx" ON "app"."ledger_entries" ("order_id", "kind", "account_id", "direction") WHERE "order_id" IS NOT NULL;

CREATE INDEX "refund_requests_order_idx" ON "app"."refund_requests" ("order_id");

CREATE UNIQUE INDEX "refund_requests_active_unique" ON "app"."refund_requests" ("order_id") WHERE "status" IN ('pending', 'approved');
