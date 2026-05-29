-- Down migration for 0011_integration_configs.

DROP TABLE IF EXISTS "app"."integration_configs";
DROP TYPE IF EXISTS "app"."integration_type";
