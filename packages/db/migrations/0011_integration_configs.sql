-- M4 Wave 1 — F4.1 integration_configs: per-org connector configuration.
-- Credentials are stored as an opaque envelope-encrypted blob; plaintext never
-- touches the database. config_json holds non-secret settings.

CREATE TYPE "app"."integration_type" AS ENUM (
  'runsignup',
  'chronotrack',
  'mylaps',
  'bayphoto',
  'gdrive',
  'dropbox',
  'sftp'
);

CREATE TABLE "app"."integration_configs" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"                uuid NOT NULL,                          -- refs organizations.id (cross-context)
  "type"                  "app"."integration_type" NOT NULL,
  "enabled"               boolean NOT NULL DEFAULT false,
  -- Envelope-encrypted credential blob (see @pkg/integrations crypto).
  -- Null when soft-deleted / never configured. Raw secrets never stored.
  "encrypted_credentials" text,
  "config_json"           jsonb,
  "last_synced_at"        timestamp with time zone,
  "last_error"            text,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now()
);

-- One config row per (org, connector type).
CREATE UNIQUE INDEX "integration_configs_org_type_idx"
  ON "app"."integration_configs" ("org_id", "type");

-- List a connector's tenants for fan-out / health sweeps.
CREATE INDEX "integration_configs_type_enabled_idx"
  ON "app"."integration_configs" ("type", "enabled");
