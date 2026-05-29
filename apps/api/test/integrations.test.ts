// F4.1 — integrations service tests (fake in-memory db, real crypto).

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TABLE = Symbol('table');

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    integrations: {
      integrationConfigs: {
        [TABLE]: 'integration_configs',
        id: { column: 'id' },
        orgId: { column: 'orgId' },
        type: { column: 'type' },
        enabled: { column: 'enabled' },
        encryptedCredentials: { column: 'encryptedCredentials' },
        configJson: { column: 'configJson' },
        lastSyncedAt: { column: 'lastSyncedAt' },
        lastError: { column: 'lastError' },
        updatedAt: { column: 'updatedAt' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const val = (v: unknown, row: Record<string, unknown>) => (isField(v) ? row[v.column] : v);
  return {
    and:
      (...preds: Array<(r: Record<string, unknown>) => boolean>) =>
      (row: Record<string, unknown>) =>
        preds.every((p) => p(row)),
    eq: (a: unknown, b: unknown) => (row: Record<string, unknown>) => val(a, row) === val(b, row),
  };
});

type Row = Record<string, unknown>;
let store: Row[];

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      from: () => api,
      where: (p: (r: Row) => boolean) => {
        filters.push(p);
        return api;
      },
      limit: () => Promise.resolve(project()),
      then: (resolve: (v: Row[]) => unknown) => resolve(project()),
    };
    const project = () => {
      const rows = store.filter((r) => filters.every((f) => f(r)));
      return rows.map((r) => {
        const o: Row = {};
        for (const [alias, ref] of Object.entries(sel)) o[alias] = r[ref.column];
        return o;
      });
    };
    return api;
  };

  const insert = () => ({
    values: (v: Row) => ({
      onConflictDoUpdate: ({ set }: { set: Row }) => {
        const existing = store.find((r) => r.orgId === v.orgId && r.type === v.type);
        if (existing) Object.assign(existing, set);
        else store.push({ ...v });
        return Promise.resolve();
      },
    }),
  });

  const update = () => ({
    set: (s: Row) => ({
      where: (p: (r: Row) => boolean) => {
        for (const r of store) if (p(r)) Object.assign(r, s);
        return Promise.resolve();
      },
    }),
  });

  return { select, insert, update } as never;
};

const masterKey = randomBytes(32).toString('base64');
let svc: typeof import('../src/services/integrations.js');

beforeEach(async () => {
  store = [];
  svc = await import('../src/services/integrations.js');
});

describe('listIntegrations', () => {
  it('returns every known connector type, marking configured ones', async () => {
    const db = makeDb();
    await svc.upsertIntegration(db, 'org1', 'runsignup', { credentials: 'k' }, { masterKey });
    const list = await svc.listIntegrations(db, 'org1');
    expect(list).toHaveLength(svc.INTEGRATION_TYPES.length);
    const rsu = list.find((i) => i.type === 'runsignup');
    expect(rsu?.configured).toBe(true);
    const mylaps = list.find((i) => i.type === 'mylaps');
    expect(mylaps?.configured).toBe(false);
  });
});

describe('upsertIntegration', () => {
  it('encrypts credentials (never stored plaintext) and records a failing default test', async () => {
    const db = makeDb();
    const { test } = await svc.upsertIntegration(
      db,
      'org1',
      'runsignup',
      { credentials: 'rsu_secret' },
      { masterKey },
    );
    expect(test).toEqual({ ok: false, error: 'connector_not_implemented' });
    const row = store[0];
    expect(row?.encryptedCredentials).toBeTruthy();
    expect(String(row?.encryptedCredentials)).not.toContain('rsu_secret');
    expect(row?.lastError).toBe('connector_not_implemented');
  });

  it('records last_synced_at and clears error when the injected tester passes', async () => {
    const db = makeDb();
    const tester = vi.fn(async () => ({ ok: true }));
    const { status, test } = await svc.upsertIntegration(
      db,
      'org1',
      'bayphoto',
      { credentials: 'k', config: { lab: 'bay' } },
      { masterKey, tester },
    );
    expect(test).toEqual({ ok: true });
    expect(status.enabled).toBe(true);
    expect(status.lastError).toBeNull();
    expect(status.lastSyncedAt).not.toBeNull();
    expect(status.config).toEqual({ lab: 'bay' });
    expect(tester).toHaveBeenCalledWith('bayphoto', 'k', { lab: 'bay' });
  });

  it('never exposes credentials in the returned status', async () => {
    const db = makeDb();
    const { status } = await svc.upsertIntegration(
      db,
      'org1',
      'dropbox',
      { credentials: 'super-secret' },
      { masterKey, tester: async () => ({ ok: true }) },
    );
    expect(JSON.stringify(status)).not.toContain('super-secret');
    expect('encryptedCredentials' in status).toBe(false);
  });
});

describe('deleteIntegration', () => {
  it('soft-deletes: disables and clears the encrypted credentials', async () => {
    const db = makeDb();
    await svc.upsertIntegration(db, 'org1', 'gdrive', { credentials: 'k' }, { masterKey });
    await svc.deleteIntegration(db, 'org1', 'gdrive');
    const row = store[0];
    expect(row?.enabled).toBe(false);
    expect(row?.encryptedCredentials).toBeNull();
  });
});

describe('testIntegration', () => {
  it('decrypts stored credentials and passes them to the tester', async () => {
    const db = makeDb();
    await svc.upsertIntegration(
      db,
      'org1',
      'chronotrack',
      { credentials: 'ct_key' },
      { masterKey },
    );
    const tester = vi.fn(async () => ({ ok: true }));
    const result = await svc.testIntegration(db, 'org1', 'chronotrack', { masterKey, tester });
    expect(result).toEqual({ ok: true });
    expect(tester).toHaveBeenCalledWith('chronotrack', 'ct_key', null);
  });

  it('throws not_found when the connector is not configured', async () => {
    const db = makeDb();
    await expect(svc.testIntegration(db, 'org1', 'mylaps', { masterKey })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
