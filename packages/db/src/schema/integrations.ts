// Integrations context — per-org connector configuration (F4.1).
// All tables in the Postgres `app` schema.
//
// Credentials are stored as an opaque envelope-encrypted blob
// (`encrypted_credentials`); the plaintext never touches the database and is
// decrypted in-memory only for a job's lifetime. config_json holds
// non-secret connector settings (base URLs, feature flags, bound ids).
//
// Scope: configs are per-org (credentials like a print-lab or RunSignup API
// key are org-wide). Per-event bindings (finish_events, sftp_accounts,
// cloud_imports) live in their own tables in later F4 issues.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

// Connector kinds. Adding a connector requires a migration (the enum is the
// single source of truth for "which integrations exist").
export const integrationType = app.enum('integration_type', [
  'runsignup',
  'chronotrack',
  'mylaps',
  'bayphoto',
  'gdrive',
  'dropbox',
  'sftp',
]);

export const integrationConfigs = app.table(
  'integration_configs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs organizations.id — cross-context, no FK.
    orgId: uuid('org_id').notNull(),
    type: integrationType('type').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    // Envelope-encrypted credential blob (see @pkg/integrations crypto). Null
    // when the connector has been soft-deleted / never configured.
    encryptedCredentials: text('encrypted_credentials'),
    // Non-secret connector settings (base URL, feature flags, bound ids).
    configJson: jsonb('config_json'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // One config row per (org, connector type).
    orgTypeIdx: uniqueIndex('integration_configs_org_type_idx').on(table.orgId, table.type),
    // List a connector's tenants for fan-out / health sweeps.
    typeEnabledIdx: index('integration_configs_type_enabled_idx').on(table.type, table.enabled),
  }),
);

export const tables = {
  integrationConfigs,
};
