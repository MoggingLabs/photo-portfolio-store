-- Down migration for 0000_initial.sql.
-- Drops the entire app schema with all its tables, indexes, and enums.
-- This is the nuclear rollback option; it deletes all data in the app schema.

DROP SCHEMA IF EXISTS "app" CASCADE;
