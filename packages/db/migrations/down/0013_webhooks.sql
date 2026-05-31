-- Down migration for 0013_webhooks.

DROP TABLE IF EXISTS "app"."webhook_deliveries";
DROP TABLE IF EXISTS "app"."webhook_subscriptions";
DROP TYPE IF EXISTS "app"."webhook_delivery_status";
