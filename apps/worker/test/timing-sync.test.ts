// F4.6 — timing sync sweep tests (fake db, stub adapter).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  schema: {
    timing: {
      eventTimingBindings: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        provider: { column: 'provider' },
        externalEventId: { column: 'externalEventId' },
        credentialsEncrypted: { column: 'credentialsEncrypted' },
        lastSyncedAt: { column: 'lastSyncedAt' },
        enabled: { column: 'enabled' },
      },
      finishEvents: {
        eventId: { column: 'eventId' },
        bib: { column: 'bib' },
        splitName: { column: 'splitName' },
      },
    },
    participants: { participants: { eventId: { column: 'eventId' }, bib: { column: 'bib' } } },
  },
}));

vi.mock('@pkg/integrations', async (orig) => {
  const actual = await orig<typeof import('@pkg/integrations')>();
  return { ...actual, decryptCredentials: () => 'api-key' };
});

vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

interface Row {
  [k: string]: unknown;
}
let bindings: Row[];
let parts: Row[];
let finishes: Row[];

const makeDb = () => ({
  select: () => {
    const api = {
      from: () => api,
      where: () => api,
      limit: () => Promise.resolve(bindings),
    };
    return api;
  },
  insert: (t: { __b?: string }) => ({
    values: (v: Row) => ({
      onConflictDoUpdate: ({ set }: { set: Row }) => {
        const bucket = t.__b === 'finish' ? finishes : parts;
        const key = t.__b === 'finish' ? ['eventId', 'bib', 'splitName'] : ['eventId', 'bib'];
        const existing = bucket.find((r) => key.every((k) => r[k] === v[k]));
        if (existing) Object.assign(existing, set);
        else bucket.push({ ...v });
        return Promise.resolve();
      },
    }),
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
});

let job: typeof import('../src/jobs/timing-sync.js');
const NOW = new Date('2026-06-01T12:00:00Z');

beforeEach(async () => {
  bindings = [];
  parts = [];
  finishes = [];
  const { schema } = await import('@pkg/db');
  (schema.timing.finishEvents as { __b?: string }).__b = 'finish';
  (schema.participants.participants as { __b?: string }).__b = 'parts';
  job = await import('../src/jobs/timing-sync.js');
});

const binding = (over: Row = {}): Row => ({
  id: 'b1',
  eventId: 'e1',
  provider: 'runsignup',
  externalEventId: 'race1',
  credentialsEncrypted: 'enc',
  lastSyncedAt: null,
  ...over,
});

const stubAdapter = (roster: unknown[], finishesOut: unknown[]) => ({
  provider: 'runsignup' as const,
  pullRoster: async () => roster,
  pullFinishEvents: async () => finishesOut,
});

describe('runTimingSync', () => {
  it('upserts participants and finish events for an enabled binding', async () => {
    bindings = [binding()];
    const adapter = stubAdapter(
      [{ bib: '101', firstName: 'Ada', lastName: 'L', email: 'a@x.io' }],
      [{ bib: '101', splitName: 'finish', gunTimeMs: 1200000, recordedAt: NOW, raw: {} }],
    );
    const res = await job.runTimingSync(makeDb() as never, {
      masterKey: 'mk',
      adapterFactory: () => adapter as never,
      now: () => NOW,
    });
    expect(res.rosterUpserted).toBe(1);
    expect(res.finishUpserted).toBe(1);
    expect(parts[0]).toMatchObject({ eventId: 'e1', bib: '101', name: 'Ada L', email: 'a@x.io' });
    expect(finishes[0]).toMatchObject({ bib: '101', source: 'runsignup' });
  });

  it('is idempotent: re-syncing the same bib updates, not duplicates', async () => {
    bindings = [binding()];
    const adapter = stubAdapter([{ bib: '7', firstName: 'B', lastName: 'C' }], []);
    const db = makeDb();
    await job.runTimingSync(db as never, {
      masterKey: 'mk',
      adapterFactory: () => adapter as never,
      now: () => NOW,
    });
    await job.runTimingSync(db as never, {
      masterKey: 'mk',
      adapterFactory: () => adapter as never,
      now: () => NOW,
    });
    expect(parts).toHaveLength(1);
  });

  it('records an error and continues when the adapter throws', async () => {
    bindings = [binding()];
    const adapter = {
      provider: 'runsignup' as const,
      pullRoster: async () => {
        throw new Error('boom');
      },
      pullFinishEvents: async () => [],
    };
    const res = await job.runTimingSync(makeDb() as never, {
      masterKey: 'mk',
      adapterFactory: () => adapter as never,
      now: () => NOW,
    });
    expect(res.errors).toHaveLength(1);
    expect(res.bindingsProcessed).toBe(1);
  });

  it('records unsupported_provider when the factory returns null', async () => {
    bindings = [binding({ provider: 'mylaps' })];
    const res = await job.runTimingSync(makeDb() as never, {
      masterKey: 'mk',
      adapterFactory: () => null,
      now: () => NOW,
    });
    expect(res.errors[0]?.error).toBe('unsupported_provider');
  });
});
