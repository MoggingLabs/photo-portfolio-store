-- Reverses 0005_commerce_depth.sql

DROP INDEX IF EXISTS "app"."refund_requests_active_unique";
DROP INDEX IF EXISTS "app"."refund_requests_order_idx";
DROP INDEX IF EXISTS "app"."ledger_entries_dedupe_idx";
DROP INDEX IF EXISTS "app"."ledger_entries_order_idx";
DROP INDEX IF EXISTS "app"."ledger_entries_account_created_idx";
DROP INDEX IF EXISTS "app"."payouts_account_period_idx";
DROP INDEX IF EXISTS "app"."payout_accounts_status_idx";
DROP INDEX IF EXISTS "app"."pricing_rule_targets_target_idx";
DROP INDEX IF EXISTS "app"."pricing_rules_scope_active_idx";
DROP INDEX IF EXISTS "app"."bundles_event_active_idx";

DROP TABLE IF EXISTS "app"."refund_requests";
DROP TABLE IF EXISTS "app"."ledger_entries";
DROP TABLE IF EXISTS "app"."payouts";
DROP TABLE IF EXISTS "app"."payout_accounts";
DROP TABLE IF EXISTS "app"."pricing_rule_targets";
DROP TABLE IF EXISTS "app"."pricing_rules";
DROP TABLE IF EXISTS "app"."bundle_items";
DROP TABLE IF EXISTS "app"."bundles";

DROP TYPE IF EXISTS "app"."refund_request_status";
DROP TYPE IF EXISTS "app"."payout_status";
DROP TYPE IF EXISTS "app"."ledger_kind";
DROP TYPE IF EXISTS "app"."ledger_direction";
DROP TYPE IF EXISTS "app"."pricing_rule_kind";
DROP TYPE IF EXISTS "app"."pricing_rule_scope";
DROP TYPE IF EXISTS "app"."bundle_kind";
