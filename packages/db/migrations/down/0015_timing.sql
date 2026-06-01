-- Down migration for 0015_timing.

DROP TABLE IF EXISTS "app"."finish_events";
DROP TABLE IF EXISTS "app"."event_timing_bindings";
DROP TYPE IF EXISTS "app"."timing_provider";
