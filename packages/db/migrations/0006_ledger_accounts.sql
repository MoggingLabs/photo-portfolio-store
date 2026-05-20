-- F2.11 ledger foundation + F2.7 refund tracking.
-- Introduces internal double-entry accounts (ledger_accounts) and repoints
-- ledger_entries.account_id from payout_accounts to ledger_accounts so the
-- platform side (cash, revenue, stripe_fee) can be represented alongside
-- photographer accounts. Also adds refund bookkeeping columns.
-- All objects live in the "app" schema.

-- ------------------------------------------------------------------ enums --

CREATE TYPE "app"."ledger_account_kind" AS ENUM (
  'platform_cash',
  'platform_revenue',
  'stripe_fee',
  'photographer'
);

-- ---------------------------------------------------------------- tables --

-- ledger_accounts: platform kinds are singletons; photographer rows are
-- one-per-user and exist independently of the Stripe payout account.
-- photographer_id refs users.id (cross-context, no FK).
CREATE TABLE "app"."ledger_accounts" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"            "app"."ledger_account_kind" NOT NULL,
  "photographer_id" uuid,                                                    -- refs users.id (cross-context)
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ledger_accounts_platform_kind_unique"
  ON "app"."ledger_accounts" ("kind")
  WHERE "kind" <> 'photographer';

CREATE UNIQUE INDEX "ledger_accounts_photographer_unique"
  ON "app"."ledger_accounts" ("photographer_id")
  WHERE "kind" = 'photographer';

-- Repoint ledger_entries.account_id: payout_accounts -> ledger_accounts.
-- Greenfield (no rows), so dropping and re-adding the FK is safe.
ALTER TABLE "app"."ledger_entries"
  DROP CONSTRAINT IF EXISTS "ledger_entries_account_id_payout_accounts_id_fk";
ALTER TABLE "app"."ledger_entries"
  DROP CONSTRAINT IF EXISTS "ledger_entries_account_id_fkey";
ALTER TABLE "app"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "app"."ledger_accounts" ("id");

-- Refine the dedupe indexes: the 0005 index collided across multiple partial
-- refunds on one order. Split into a sale/fee dedupe (refund_id IS NULL) plus a
-- per-refund dedupe.
DROP INDEX IF EXISTS "app"."ledger_entries_dedupe_idx";

CREATE UNIQUE INDEX "ledger_entries_sale_dedupe_idx"
  ON "app"."ledger_entries" ("order_id", "kind", "account_id", "direction")
  WHERE "order_id" IS NOT NULL AND "refund_id" IS NULL;

CREATE UNIQUE INDEX "ledger_entries_refund_dedupe_idx"
  ON "app"."ledger_entries" ("refund_id", "account_id", "direction")
  WHERE "refund_id" IS NOT NULL;

-- ------------------------------------------------------ refund bookkeeping --

ALTER TABLE "app"."orders"
  ADD COLUMN "refunded_cents" integer NOT NULL DEFAULT 0;

ALTER TABLE "app"."refund_requests"
  ADD COLUMN "approved_amount_cents" integer;
ALTER TABLE "app"."refund_requests"
  ADD COLUMN "stripe_refund_id" text;
ALTER TABLE "app"."refund_requests"
  ADD COLUMN "refund_attempts" integer NOT NULL DEFAULT 0;
