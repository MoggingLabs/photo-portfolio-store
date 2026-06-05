// F5.5 — photographer quality settings + override service tests (fake db).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const col = (column: string) => ({ column });
const cols = (...names: string[]) => Object.fromEntries(names.map((n) => [n, col(n)]));

vi.mock('@pkg/db', () => ({
  schema: {
    photographerSettings: {
      photographerSettings: cols(
        'photographerUserId',
        'qualityFilterEnabled',
        'qualityThreshold',
        'updatedAt',
      ),
    },
    photos: { photos: cols('id', 'photographerUserId', 'autoRejected', 'rejectionOverriddenAt') },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: { column?: string }, b: unknown) => (r: Record<string, unknown>) =>
    a?.column ? r[a.column] === b : false,
}));

type Row = Record<string, unknown>;
let store: Record<string, Row[]>;

const makeDb = () => ({
  select: (sel: Record<string, { column: string }>) => {
    let tn = '';
    let pred: ((r: Row) => boolean) | null = null;
    const run = () =>
      (store[tn] ?? [])
        .filter((r) => (pred ? pred(r) : true))
        .map((r) => {
          const o: Row = {};
          for (const k of Object.keys(sel)) o[k] = r[sel[k]?.column ?? k];
          return o;
        });
    const b = {
      from: (t: { __t: string }) => {
        tn = t.__t;
        return b;
      },
      where: (p: (r: Row) => boolean) => {
        pred = p;
        return b;
      },
      limit: () => Promise.resolve(run()),
    };
    return b;
  },
  insert: (t: { __t: string }) => ({
    values: (v: Row) => ({
      onConflictDoUpdate: ({ set }: { set: Row }) => {
        const rows = store[t.__t] ?? [];
        const existing = rows.find((r) => r.photographerUserId === v.photographerUserId);
        if (existing) Object.assign(existing, set);
        else rows.push({ ...v });
        return Promise.resolve();
      },
    }),
  }),
  update: (t: { __t: string }) => ({
    set: (s: Row) => ({
      where: (pred: (r: Row) => boolean) => {
        for (const r of store[t.__t] ?? []) if (pred(r)) Object.assign(r, s);
        return Promise.resolve();
      },
    }),
  }),
});

let svc: typeof import('../src/services/photographer-quality-settings.js');

beforeEach(async () => {
  store = { settings: [], photos: [] };
  const { schema } = await import('@pkg/db');
  (schema.photographerSettings.photographerSettings as { __t?: string }).__t = 'settings';
  (schema.photos.photos as { __t?: string }).__t = 'photos';
  svc = await import('../src/services/photographer-quality-settings.js');
});

describe('getQualitySettings', () => {
  it('returns disabled defaults when no row exists', async () => {
    expect(await svc.getQualitySettings(makeDb() as never, 'u1')).toEqual({
      enabled: false,
      threshold: 0.5,
    });
  });

  it('returns the stored settings', async () => {
    store.settings = [
      { photographerUserId: 'u1', qualityFilterEnabled: true, qualityThreshold: '0.70' },
    ];
    expect(await svc.getQualitySettings(makeDb() as never, 'u1')).toEqual({
      enabled: true,
      threshold: 0.7,
    });
  });
});

describe('updateQualitySettings', () => {
  it('creates a settings row', async () => {
    const r = await svc.updateQualitySettings(makeDb() as never, 'u1', {
      enabled: true,
      threshold: 0.6,
    });
    expect(r).toEqual({ enabled: true, threshold: 0.6 });
    expect(store.settings[0]).toMatchObject({
      photographerUserId: 'u1',
      qualityFilterEnabled: true,
      qualityThreshold: '0.60',
    });
  });

  it('merges a partial update, preserving the unset field', async () => {
    store.settings = [
      { photographerUserId: 'u1', qualityFilterEnabled: false, qualityThreshold: '0.40' },
    ];
    const r = await svc.updateQualitySettings(makeDb() as never, 'u1', { enabled: true });
    expect(r).toEqual({ enabled: true, threshold: 0.4 });
  });
});

describe('overrideRejection', () => {
  it('republishes an owned, rejected photo', async () => {
    store.photos = [{ id: 'p1', photographerUserId: 'u1', autoRejected: true }];
    expect(await svc.overrideRejection(makeDb() as never, 'p1', 'u1')).toBe(true);
    expect(store.photos[0]).toMatchObject({ autoRejected: false });
    expect(store.photos[0]?.rejectionOverriddenAt).toBeInstanceOf(Date);
  });

  it('returns false for a photo owned by someone else (anti-enumeration)', async () => {
    store.photos = [{ id: 'p1', photographerUserId: 'other', autoRejected: true }];
    expect(await svc.overrideRejection(makeDb() as never, 'p1', 'u1')).toBe(false);
    expect(store.photos[0]).toMatchObject({ autoRejected: true });
  });

  it('returns false for a missing photo', async () => {
    expect(await svc.overrideRejection(makeDb() as never, 'missing', 'u1')).toBe(false);
  });
});
