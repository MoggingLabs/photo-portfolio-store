// F4.1 — integrations service: per-org connector config CRUD.
//
// Credentials are envelope-encrypted (@pkg/integrations) before they touch the
// DB and are NEVER returned to callers. A connector "test call" is attempted on
// upsert and on demand; the result is recorded in last_synced_at / last_error
// but does not itself block enabling (per-connector testers land with each
// connector in F4.6+). The default tester reports not_implemented so the
// endpoint is honest until a real connector registers its checker.

import { type DbClient, schema } from '@pkg/db';
import { decryptCredentials, encryptCredentials } from '@pkg/integrations';
import { and, eq } from 'drizzle-orm';

const { integrationConfigs } = schema.integrations;

export const INTEGRATION_TYPES = [
  'runsignup',
  'chronotrack',
  'mylaps',
  'bayphoto',
  'gdrive',
  'dropbox',
  'sftp',
] as const;

export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const isIntegrationType = (v: string): v is IntegrationType =>
  (INTEGRATION_TYPES as readonly string[]).includes(v);

export class IntegrationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

// A connector connectivity checker. Receives the decrypted credentials + the
// non-secret config. Real checkers are registered per connector (F4.6+).
export type ConnectorTester = (
  type: IntegrationType,
  credentials: string,
  config: Record<string, unknown> | null,
) => Promise<TestResult>;

const defaultTester: ConnectorTester = async () => ({
  ok: false,
  error: 'connector_not_implemented',
});

// Public status view — deliberately omits encrypted_credentials.
export interface IntegrationStatus {
  type: IntegrationType;
  configured: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  config: Record<string, unknown> | null;
}

const toStatus = (
  type: IntegrationType,
  row?: {
    enabled: boolean;
    encryptedCredentials: string | null;
    configJson: unknown;
    lastSyncedAt: Date | null;
    lastError: string | null;
  },
): IntegrationStatus => ({
  type,
  configured: !!row?.encryptedCredentials,
  enabled: row?.enabled ?? false,
  lastSyncedAt: row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  lastError: row?.lastError ?? null,
  config: (row?.configJson as Record<string, unknown> | null) ?? null,
});

// ---------- list ----------

export const listIntegrations = async (
  db: DbClient,
  orgId: string,
): Promise<IntegrationStatus[]> => {
  const rows = await db
    .select({
      type: integrationConfigs.type,
      enabled: integrationConfigs.enabled,
      encryptedCredentials: integrationConfigs.encryptedCredentials,
      configJson: integrationConfigs.configJson,
      lastSyncedAt: integrationConfigs.lastSyncedAt,
      lastError: integrationConfigs.lastError,
    })
    .from(integrationConfigs)
    .where(eq(integrationConfigs.orgId, orgId));

  const byType = new Map(rows.map((r) => [r.type as IntegrationType, r]));
  // Return every known connector so the UI can show available + configured.
  return INTEGRATION_TYPES.map((t) => toStatus(t, byType.get(t)));
};

// ---------- upsert ----------

export interface UpsertInput {
  credentials?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpsertDeps {
  masterKey: string;
  tester?: ConnectorTester;
}

export const upsertIntegration = async (
  db: DbClient,
  orgId: string,
  type: IntegrationType,
  input: UpsertInput,
  deps: UpsertDeps,
): Promise<{ status: IntegrationStatus; test: TestResult | null }> => {
  const tester = deps.tester ?? defaultTester;
  const now = new Date();

  // Attempt a connectivity check when credentials are supplied.
  let test: TestResult | null = null;
  if (input.credentials !== undefined) {
    test = await tester(type, input.credentials, input.config ?? null);
  }

  const encrypted =
    input.credentials !== undefined
      ? encryptCredentials(input.credentials, deps.masterKey)
      : undefined;

  const enabled = input.enabled ?? true;
  const values = {
    orgId,
    type,
    enabled,
    ...(encrypted !== undefined ? { encryptedCredentials: encrypted } : {}),
    ...(input.config !== undefined ? { configJson: input.config } : {}),
    lastSyncedAt: test?.ok ? now : null,
    lastError: test && !test.ok ? (test.error ?? 'test_failed') : null,
    updatedAt: now,
  };

  await db
    .insert(integrationConfigs)
    .values(values)
    .onConflictDoUpdate({
      target: [integrationConfigs.orgId, integrationConfigs.type],
      set: {
        enabled: values.enabled,
        ...(encrypted !== undefined ? { encryptedCredentials: encrypted } : {}),
        ...(input.config !== undefined ? { configJson: input.config } : {}),
        lastSyncedAt: values.lastSyncedAt,
        lastError: values.lastError,
        updatedAt: now,
      },
    });

  const status = await getStatus(db, orgId, type);
  return { status, test };
};

// ---------- delete (soft) ----------

export const deleteIntegration = async (
  db: DbClient,
  orgId: string,
  type: IntegrationType,
): Promise<void> => {
  await db
    .update(integrationConfigs)
    .set({
      enabled: false,
      encryptedCredentials: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(integrationConfigs.orgId, orgId), eq(integrationConfigs.type, type)));
};

// ---------- test ----------

export const testIntegration = async (
  db: DbClient,
  orgId: string,
  type: IntegrationType,
  deps: UpsertDeps,
): Promise<TestResult> => {
  const rows = await db
    .select({
      encryptedCredentials: integrationConfigs.encryptedCredentials,
      configJson: integrationConfigs.configJson,
    })
    .from(integrationConfigs)
    .where(and(eq(integrationConfigs.orgId, orgId), eq(integrationConfigs.type, type)))
    .limit(1);
  const row = rows[0];
  if (!row?.encryptedCredentials) {
    throw new IntegrationError('not_found', 'integration not configured');
  }

  const credentials = decryptCredentials(row.encryptedCredentials, deps.masterKey);
  const tester = deps.tester ?? defaultTester;
  const result = await tester(
    type,
    credentials,
    (row.configJson as Record<string, unknown> | null) ?? null,
  );

  await db
    .update(integrationConfigs)
    .set({
      lastSyncedAt: result.ok ? new Date() : null,
      lastError: result.ok ? null : (result.error ?? 'test_failed'),
      updatedAt: new Date(),
    })
    .where(and(eq(integrationConfigs.orgId, orgId), eq(integrationConfigs.type, type)));

  return result;
};

// ---------- internal ----------

const getStatus = async (
  db: DbClient,
  orgId: string,
  type: IntegrationType,
): Promise<IntegrationStatus> => {
  const rows = await db
    .select({
      enabled: integrationConfigs.enabled,
      encryptedCredentials: integrationConfigs.encryptedCredentials,
      configJson: integrationConfigs.configJson,
      lastSyncedAt: integrationConfigs.lastSyncedAt,
      lastError: integrationConfigs.lastError,
    })
    .from(integrationConfigs)
    .where(and(eq(integrationConfigs.orgId, orgId), eq(integrationConfigs.type, type)))
    .limit(1);
  return toStatus(type, rows[0]);
};
