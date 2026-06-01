// F4.6 — timing binding API service tests (fake db, real crypto).

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    timing: {
      eventTimingBindings: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        provider: { column: 'provider' },
        externalEventId: { column: 'externalEventId' },
        credentialsEncrypted: { column: 'credentialsEncrypted' },
        enabled: { column: 'enabled' },
        lastSyncedAt: { column: 'lastSyncedAt' },
        lastError: { column: 'lastError' },
        syncRequestedAt: { column: 'syncRequestedAt' },
        createdAt: { column: 'createdAt' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => {
  type F = { column: string };
  const isF = (v: unknown): v is F => typeof v === 'object' && v !== null && 'column' in (v as F);
  const val = (v: unknown, r: Record<string, unknown>) => (isF(v) ? r[v.column] : v);
  return {
    and:
      (...p: Array<(r: Record<string, unknown>) => boolean>) =>
      (r: Record<string, unknown>) =>
        p.every((f) => f(r)),
    eq: (a: unknown, b: unknown) => (r: Record<string, unknown>) => val(a, r) === val(b, r),
    desc: (c: unknown) => ({ desc: c }),
  };
});

type Row = Record<string, unknown>;
let rows: Row[];

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      from: () => api,
      where: (p: (r: Row) => boolean) => {
        filters.push(p);
        return api;
      },
      orderBy: () => api,
      limit: () => Promise.resolve(project()),
      then: (resolve: (v: Row[]) => unknown) => resolve(project()),
    };
    const project = () =>
      rows
        .filter((r) => filters.every((f) => f(r)))
        .map((r) => {
          const o: Row = {};
          for (const [a, ref] of Object.entries(sel)) o[a] = r[ref.column];
          return o;
        });
    return api;
  };
  const insert = () => ({
    values: (v: Row) => ({
      onConflictDoUpdate: ({ set }: { set: Row }) => {
        const existing = rows.find((r) => r.eventId === v.eventId && r.provider === v.provider);
        if (existing) Object.assign(existing, set);
        else rows.push({ createdAt: new Date('2026-06-01T00:00:00Z'), ...v });
        return Promise.resolve();
      },
    }),
  });
  const update = () => ({
    set: (s: Row) => ({
      where: (p: (r: Row) => boolean) => {
        const hit = rows.filter((r) => p(r));
        for (const r of hit) Object.assign(r, s);
        return { returning: () => Promise.resolve(hit.map((r) => ({ id: r.id }))) };
      },
    }),
  });
  return { select, insert, update } as never;
};

const masterKey = randomBytes(32).toString('base64');
let svc: typeof import('../src/services/timing.js');

beforeEach(async () => {
  rows = [];
  svc = await import('../src/services/timing.js');
});

describe('bindTimingProvider', () => {
  it('encrypts the API key (never stored/returned plaintext) and upserts', async () => {
    const db = makeDb();
    const view = await svc.bindTimingProvider(
      db,
      { eventId: 'e1', provider: 'runsignup', externalEventId: 'race1', apiKey: 'rsu-secret' },
      { masterKey },
    );
    expect(view.externalEventId).toBe('race1');
    expect(view.enabled).toBe(true);
    expect(JSON.stringify(view)).not.toContain('rsu-secret');
    expect(String(rows[0]?.credentialsEncrypted)).not.toContain('rsu-secret');
  });

  it('re-binding the same (event, provider) updates rather than duplicates', async () => {
    const db = makeDb();
    await svc.bindTimingProvider(
      db,
      { eventId: 'e1', provider: 'runsignup', externalEventId: 'r1', apiKey: 'k' },
      { masterKey },
    );
    await svc.bindTimingProvider(
      db,
      { eventId: 'e1', provider: 'runsignup', externalEventId: 'r2', apiKey: 'k2' },
      { masterKey },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalEventId).toBe('r2');
  });
});

describe('requestSync', () => {
  it('stamps sync_requested_at for an existing binding', async () => {
    const db = makeDb();
    await svc.bindTimingProvider(
      db,
      { eventId: 'e1', provider: 'runsignup', externalEventId: 'r1', apiKey: 'k' },
      { masterKey },
    );
    const res = await svc.requestSync(db, 'e1', 'runsignup');
    expect(res.requested).toBe(true);
    expect(rows[0]?.syncRequestedAt).toBeInstanceOf(Date);
  });

  it('throws not_found when no binding exists', async () => {
    const db = makeDb();
    await expect(svc.requestSync(db, 'e1', 'mylaps')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('listBindings', () => {
  it('returns bindings without secrets', async () => {
    const db = makeDb();
    await svc.bindTimingProvider(
      db,
      { eventId: 'e1', provider: 'runsignup', externalEventId: 'r1', apiKey: 'k' },
      { masterKey },
    );
    const items = await svc.listBindings(db, 'e1');
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('credentialsEncrypted');
  });
});
