-- Down migration for 0019_cloud_imports.

DROP TABLE IF EXISTS "app"."cloud_import_files";
DROP TABLE IF EXISTS "app"."cloud_imports";
DROP TYPE IF EXISTS "app"."cloud_import_file_status";
DROP TYPE IF EXISTS "app"."cloud_import_status";
DROP TYPE IF EXISTS "app"."cloud_import_provider";
