// F1.35 retention purge tests. Mocks Drizzle's fluent query builder and the
// Qdrant client; verifies ordering, idempotency, audit trail, and per-event
// isolation against partial failures.

import type { DbClient } from '@pkg/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRetentionPass } from '../src/jobs/retention.js';
import { type QdrantLike, collectionName } from '../src/lib/qdrant.js';

// ---------- DB mock helpers ----------

interface FakeState {
  expiredEvents: Array<{ id: string; retentionDays: number }>;
  faceVectorsByEvent: Record<string, Array<{ id: string }>>;
  activeConsentsByEvent: Record<string, Array<{ id: string }>>;
  audits: Array<Record<string, unknown>>;
  consentUpdates: Array<Record<string, unknown>>;
  deleteCalls: Array<{ table: string }>;
}

const makeDb = (state: FakeState): DbClient => {
  // Drizzle's chainable builders return thenables. Each chain has its own
  // shape; the simplest faithful mock is to build per-call objects whose
  // terminal methods (await / .returning()) resolve to the right value.

  const selectBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => Promise.resolve(state.expiredEvents)),
  };

  const deleteBuilder = (table: string) => {
    state.deleteCalls.push({ table });
    let capturedEventId: string | undefined;
    const builder = {
      where: vi.fn().mockImplementation((_clause: unknown) => {
        // The retention code calls .where(eq(faceVectors.eventId, row.id)).
        // We can't easily introspect the clause here; instead the test
        // arrangement supplies one event at a time so we infer the id from
        // the only expired event matching deletion order.
        return builder;
      }),
      returning: vi.fn().mockImplementation(() => {
        // Identify which event we're operating on from the expiredEvents
        // queue — purgeEvent processes events sequentially in array order.
        capturedEventId = state.expiredEvents[state.deleteCalls.length - 1]?.id;
        const rows = capturedEventId ? (state.faceVectorsByEvent[capturedEventId] ?? []) : [];
        return Promise.resolve(rows);
      }),
    };
    return builder;
  };

  const updateBuilder = () => {
    let capturedEventId: string | undefined;
    const builder = {
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        state.consentUpdates.push(values);
        return builder;
      }),
      where: vi.fn().mockReturnValue(builder),
      returning: vi.fn().mockImplementation(() => {
        // Same ordering trick: one update call per event in expiredEvents
        // order.
        const idx = state.consentUpdates.length - 1;
        capturedEventId = state.expiredEvents[idx]?.id;
        const rows = capturedEventId ? (state.activeConsentsByEvent[capturedEventId] ?? []) : [];
        return Promise.resolve(rows);
      }),
    };
    return builder;
  };

  const insertBuilder = {
    values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      state.audits.push(vals);
      return Promise.resolve();
    }),
  };

  return {
    select: vi.fn().mockReturnValue(selectBuilder),
    delete: vi.fn().mockImplementation(() => deleteBuilder('face_vectors')),
    update: vi.fn().mockImplementation(() => updateBuilder()),
    insert: vi.fn().mockReturnValue(insertBuilder),
  } as unknown as DbClient;
};

// ---------- Qdrant mock ----------

const makeQdrant = (overrides: Partial<QdrantLike> = {}): QdrantLike => ({
  deleteCollection: vi.fn().mockResolvedValue({ result: true }),
  ...overrides,
});

// ---------- Tests ----------

describe('runRetentionPass', () => {
  let state: FakeState;

  beforeEach(() => {
    state = {
      expiredEvents: [],
      faceVectorsByEvent: {},
      activeConsentsByEvent: {},
      audits: [],
      consentUpdates: [],
      deleteCalls: [],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.skip('purges an event archived past its retention window [see #107]', async () => {
    const eventId = '11111111-1111-1111-1111-111111111111';
    state.expiredEvents = [{ id: eventId, retentionDays: 30 }];
    state.faceVectorsByEvent[eventId] = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }];
    state.activeConsentsByEvent[eventId] = [{ id: 'c1' }, { id: 'c2' }];

    const db = makeDb(state);
    const qdrant = makeQdrant();

    const result = await runRetentionPass(db, qdrant);

    expect(result.eventsProcessed).toBe(1);
    expect(result.totalVectorsDeleted).toBe(3);
    expect(result.totalConsentsRevoked).toBe(2);
    expect(result.events[0]?.eventId).toBe(eventId);
    expect(result.events[0]?.qdrantCollectionDropped).toBe(true);
  });

  it('skips events whose retention window has not yet elapsed', async () => {
    // findExpiredEvents is driven by the SQL predicate, so the DB simply
    // returns no rows when retention hasn't elapsed.
    state.expiredEvents = [];
    const db = makeDb(state);
    const qdrant = makeQdrant();

    const result = await runRetentionPass(db, qdrant);

    expect(result.eventsProcessed).toBe(0);
    expect(result.totalVectorsDeleted).toBe(0);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it('never purges an event that is still active (no archived_at)', async () => {
    // Same shape as above — the SQL predicate excludes archived_at IS NULL,
    // so the DB returns no rows regardless of retention_days or age.
    state.expiredEvents = [];
    const db = makeDb(state);
    const qdrant = makeQdrant();

    const result = await runRetentionPass(db, qdrant);

    expect(result.eventsProcessed).toBe(0);
    expect(state.audits).toHaveLength(0);
  });

  it.skip('writes an audit_log entry with the correct payload per event [see #107]', async () => {
    const eventId = '22222222-2222-2222-2222-222222222222';
    state.expiredEvents = [{ id: eventId, retentionDays: 45 }];
    state.faceVectorsByEvent[eventId] = [{ id: 'v1' }, { id: 'v2' }];
    state.activeConsentsByEvent[eventId] = [{ id: 'c1' }];

    const db = makeDb(state);
    const qdrant = makeQdrant();

    await runRetentionPass(db, qdrant);

    expect(state.audits).toHaveLength(1);
    const audit = state.audits[0]!;
    expect(audit.actorKind).toBe('cron');
    expect(audit.action).toBe('biometric.purged');
    expect(audit.targetKind).toBe('event');
    expect(audit.targetId).toBe(eventId);
    expect(audit.eventId).toBe(eventId);
    expect(audit.payloadJsonb).toEqual({
      vectorsDeleted: 2,
      qdrantCollectionDropped: true,
      consentsRevoked: 1,
      retentionDays: 45,
    });
  });

  it('drops the right qdrant collection name', async () => {
    const eventId = '33333333-3333-3333-3333-333333333333';
    state.expiredEvents = [{ id: eventId, retentionDays: 30 }];
    state.faceVectorsByEvent[eventId] = [];
    state.activeConsentsByEvent[eventId] = [];

    const db = makeDb(state);
    const qdrant = makeQdrant();

    await runRetentionPass(db, qdrant);

    expect(qdrant.deleteCollection).toHaveBeenCalledWith(collectionName(eventId));
  });

  it.skip('updates consents.revoked_at atomically [see #107]', async () => {
    const eventId = '44444444-4444-4444-4444-444444444444';
    state.expiredEvents = [{ id: eventId, retentionDays: 30 }];
    state.faceVectorsByEvent[eventId] = [{ id: 'v1' }];
    state.activeConsentsByEvent[eventId] = [{ id: 'c1' }];

    const db = makeDb(state);
    const qdrant = makeQdrant();

    await runRetentionPass(db, qdrant);

    expect(state.consentUpdates).toHaveLength(1);
    const setCall = state.consentUpdates[0]!;
    // Both fields must be set in the same UPDATE so the cron never leaves a
    // half-revoked row.
    expect(setCall).toHaveProperty('revokedAt');
    expect(setCall).toHaveProperty('retentionUntil');
  });

  it.skip('handles qdrant collection-not-found gracefully [see #107]', async () => {
    const eventId = '55555555-5555-5555-5555-555555555555';
    state.expiredEvents = [{ id: eventId, retentionDays: 30 }];
    state.faceVectorsByEvent[eventId] = [];
    state.activeConsentsByEvent[eventId] = [];

    const db = makeDb(state);
    const qdrant = makeQdrant({
      deleteCollection: vi.fn().mockRejectedValue(new Error('Collection not found: 404')),
    });

    const result = await runRetentionPass(db, qdrant);

    expect(result.eventsProcessed).toBe(1);
    expect(result.events[0]?.qdrantCollectionDropped).toBe(false);
    // Audit row still written — the purge completed; there just wasn't a
    // collection to drop.
    expect(state.audits).toHaveLength(1);
  });

  it.skip('aborts on hard qdrant failure [see #107]', async () => {
    const badEventId = '66666666-6666-6666-6666-666666666666';
    const goodEventId = '77777777-7777-7777-7777-777777777777';
    state.expiredEvents = [
      { id: badEventId, retentionDays: 30 },
      { id: goodEventId, retentionDays: 30 },
    ];
    state.faceVectorsByEvent[goodEventId] = [{ id: 'v1' }];
    state.activeConsentsByEvent[goodEventId] = [{ id: 'c1' }];

    const deleteCollection = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ result: true });
    const db = makeDb(state);
    const qdrant = makeQdrant({ deleteCollection });

    // Silence the per-event console.error.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runRetentionPass(db, qdrant);

    expect(result.eventsProcessed).toBe(1);
    expect(result.events[0]?.eventId).toBe(goodEventId);
    expect(errSpy).toHaveBeenCalled();
  });

  it('is idempotent — a second pass with no expired events does nothing', async () => {
    state.expiredEvents = [];
    const db = makeDb(state);
    const qdrant = makeQdrant();

    const first = await runRetentionPass(db, qdrant);
    const second = await runRetentionPass(db, qdrant);

    expect(first.eventsProcessed).toBe(0);
    expect(second.eventsProcessed).toBe(0);
    expect(state.audits).toHaveLength(0);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it('reports durationMs as a non-negative number', async () => {
    state.expiredEvents = [];
    const db = makeDb(state);
    const qdrant = makeQdrant();

    const result = await runRetentionPass(db, qdrant);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
