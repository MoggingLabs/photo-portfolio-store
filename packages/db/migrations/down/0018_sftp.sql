-- Down migration for 0018_sftp.

DROP TABLE IF EXISTS "app"."sftp_uploads";
DROP TABLE IF EXISTS "app"."sftp_accounts";
DROP TYPE IF EXISTS "app"."sftp_account_status";
