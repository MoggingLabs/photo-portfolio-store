-- Reverses 0006_ledger_accounts.sql

ALTER TABLE "app"."refund_requests" DROP COLUMN IF EXISTS "refund_attempts";
ALTER TABLE "app"."refund_requests" DROP COLUMN IF EXISTS "stripe_refund_id";
ALTER TABLE "app"."refund_requests" DROP COLUMN IF EXISTS "approved_amount_cents";

ALTER TABLE "app"."orders" DROP COLUMN IF EXISTS "refunded_cents";

-- Restore the original single dedupe index from 0005.
DROP INDEX IF EXISTS "app"."ledger_entries_refund_dedupe_idx";
DROP INDEX IF EXISTS "app"."ledger_entries_sale_dedupe_idx";
CREATE UNIQUE INDEX "ledger_entries_dedupe_idx"
  ON "app"."ledger_entries" ("order_id", "kind", "account_id", "direction")
  WHERE "order_id" IS NOT NULL;

-- Restore the original ledger_entries.account_id FK to payout_accounts.
ALTER TABLE "app"."ledger_entries"
  DROP CONSTRAINT IF EXISTS "ledger_entries_account_id_ledger_accounts_id_fk";
ALTER TABLE "app"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_account_id_payout_accounts_id_fk"
  FOREIGN KEY ("account_id") REFERENCES "app"."payout_accounts" ("id");

DROP INDEX IF EXISTS "app"."ledger_accounts_photographer_unique";
DROP INDEX IF EXISTS "app"."ledger_accounts_platform_kind_unique";
DROP TABLE IF EXISTS "app"."ledger_accounts";

DROP TYPE IF EXISTS "app"."ledger_account_kind";
