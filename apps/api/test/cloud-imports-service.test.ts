// F4.4 — cloud-imports service tests (fake db).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const col = (column: string) => ({ column });
const cols = (...names: string[]) => Object.fromEntries(names.map((n) => [n, col(n)]));

vi.mock('@pkg/db', () => ({
  schema: {
    cloudImports: {
      cloudImports: cols(
        'id',
        'eventId',
        'orgId',
        'photographerUserId',
        'provider',
        'remoteFolderId',
        'status',
        'totalFiles',
        'importedFiles',
        'failedFiles',
        'startedAt',
        'completedAt',
        'lastError',
      ),
    },
    integrations: { integrationConfigs: cols('orgId', 'type', 'enabled', 'encryptedCredentials') },
    events: { events: cols('id', 'orgId') },
  },
}));

vi.mock('drizzle-orm', () => {
  type Col = { column: string };
  const isCol = (v: unknown): v is Col =>
    typeof v === 'object' && v !== null && 'column' in (v as Col);
  const valOf = (v: unknown, r: Record<string, unknown>) => (isCol(v) ? r[v.column] : v);
  return {
    eq: (a: unknown, b: unknown) => (r: Record<string, unknown>) => valOf(a, r) === valOf(b, r),
    and:
      (...ps: Array<(r: Record<string, unknown>) => boolean>) =>
      (r: Record<string, unknown>) =>
        ps.every((p) => p(r)),
  };
});

type Row = Record<string, unknown>;
let store: Record<string, Row[]>;

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    let tn = '';
    let pred: ((r: Row) => boolean) | null = null;
    const project = (r: Row): Row => {
      const o: Row = {};
      for (const k of Object.keys(sel)) o[k] = r[sel[k]?.column ?? k];
      return o;
    };
    const run = (lim?: number) => {
      let rows = (store[tn] ?? []).slice();
      if (pred) rows = rows.filter(pred);
      if (lim != null) rows = rows.slice(0, lim);
      return rows.map(project);
    };
    const b = {
      from: (t: { __t: string }) => {
        tn = t.__t;
        return b;
      },
      where: (p: (r: Row) => boolean) => {
        pred = p;
        return b;
      },
      limit: (n: number) => Promise.resolve(run(n)),
      then: (res: (v: Row[]) => unknown) => Promise.resolve(run()).then(res),
    };
    return b;
  };
  const insert = (t: { __t: string }) => ({
    values: (v: Row) => ({
      returning: () => {
        const rows = store[t.__t] ?? [];
        const id = `${t.__t}-${rows.length + 1}`;
        rows.push({ id, ...v });
        return Promise.resolve([{ id }]);
      },
    }),
  });
  return { select, insert };
};

let svc: typeof import('../src/services/cloud-imports.js');
const EV = 'ev1';
const ORG = 'org1';

beforeEach(async () => {
  store = { imports: [], configs: [], events: [] };
  const { schema } = await import('@pkg/db');
  (schema.cloudImports.cloudImports as { __t?: string }).__t = 'imports';
  (schema.integrations.integrationConfigs as { __t?: string }).__t = 'configs';
  (schema.events.events as { __t?: string }).__t = 'events';
  svc = await import('../src/services/cloud-imports.js');
});

describe('createCloudImport', () => {
  it('creates a pending import for a connected provider', async () => {
    store.events = [{ id: EV, orgId: ORG }];
    store.configs = [{ orgId: ORG, type: 'gdrive', enabled: true, encryptedCredentials: 'enc' }];
    const res = await svc.createCloudImport(makeDb() as never, {
      eventId: EV,
      userId: 'u1',
      provider: 'gdrive',
      remoteFolderId: 'folder-1',
    });
    expect(res).toMatchObject({ status: 'pending' });
    expect(store.imports[0]).toMatchObject({
      eventId: EV,
      orgId: ORG,
      photographerUserId: 'u1',
      provider: 'gdrive',
      remoteFolderId: 'folder-1',
      status: 'pending',
    });
  });

  it('throws event_not_found for an unknown event', async () => {
    await expect(
      svc.createCloudImport(makeDb() as never, {
        eventId: 'missing',
        userId: 'u1',
        provider: 'gdrive',
        remoteFolderId: 'f',
      }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });

  it('throws not_connected when the provider has no enabled connection', async () => {
    store.events = [{ id: EV, orgId: ORG }];
    store.configs = [{ orgId: ORG, type: 'gdrive', enabled: false, encryptedCredentials: null }];
    await expect(
      svc.createCloudImport(makeDb() as never, {
        eventId: EV,
        userId: 'u1',
        provider: 'gdrive',
        remoteFolderId: 'f',
      }),
    ).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('getCloudImportProgress', () => {
  it('returns progress with a linear ETA for a running import', async () => {
    const started = new Date('2026-06-01T12:00:00Z');
    const now = new Date('2026-06-01T12:01:40Z'); // +100s
    store.imports = [
      {
        id: 'imp1',
        eventId: EV,
        status: 'running',
        provider: 'gdrive',
        remoteFolderId: 'f',
        totalFiles: 10,
        importedFiles: 4,
        failedFiles: 0,
        startedAt: started,
        completedAt: null,
        lastError: null,
      },
    ];
    const p = await svc.getCloudImportProgress(makeDb() as never, EV, 'imp1', () => now);
    // done=4 over 100s -> 0.04/s; remaining 6 -> ~150s.
    expect(p).toMatchObject({ status: 'running', importedFiles: 4, etaSeconds: 150 });
    expect(p?.startedAt).toBe(started.toISOString());
  });

  it('returns null when the import is not in the event', async () => {
    store.imports = [{ id: 'imp1', eventId: 'other', status: 'pending' }];
    expect(await svc.getCloudImportProgress(makeDb() as never, EV, 'imp1')).toBeNull();
  });
});
