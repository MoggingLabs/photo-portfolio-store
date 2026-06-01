-- Down migration for 0014_print_fulfillment.

DROP TABLE IF EXISTS "app"."print_lab_webhook_events";
DROP TABLE IF EXISTS "app"."print_lab_orders";
DROP TYPE IF EXISTS "app"."print_lab_order_state";
