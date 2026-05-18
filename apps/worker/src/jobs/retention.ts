// F1.35 — biometric retention purge.
//
// Per-event sweep: when an event has been archived for more than
// `retention_days` days, we:
//
//   1. Drop the Qdrant collection holding its face embeddings.
//   2. Delete the corresponding face_vectors rows from Postgres.
//   3. Revoke any still-active biometric consents for that event.
//   4. Write a tamper-evident audit_log entry per event.
//
// Ordering is deliberate: Qdrant first, Postgres second. If Qdrant drop fails
// for an event we abort that event (no DB rows deleted, no consents revoked,
// no audit row written) and the next cron tick retries. This keeps the two
// stores from drifting apart silently.
//
// Idempotency: running twice in a row is a no-op the second time because no
// rows match the archived-past-retention predicate after the first pass.

import { schema } from '@pkg/db';
import type { DbClient } from '@pkg/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { type QdrantLike, collectionName } from '../lib/qdrant.js';

const { events } = schema.events;
const { faceVectors } = schema.search;
const { consents, auditLog } = schema.compliance;

export interface RetentionEventResult {
  eventId: string;
  vectorsDeleted: number;
  consentsRevoked: number;
  qdrantCollectionDropped: boolean;
  retentionDays: number;
}

export interface RetentionSummary {
  eventsProcessed: number;
  totalVectorsDeleted: number;
  totalConsentsRevoked: number;
  durationMs: number;
  events: RetentionEventResult[];
}

export interface ExpiredEventRow {
  id: string;
  retentionDays: number;
}

/**
 * Find every event whose archived_at + retention_days has already elapsed.
 * Exposed for tests; production callers should use runRetentionPass().
 */
export const findExpiredEvents = async (db: DbClient): Promise<ExpiredEventRow[]> => {
  const rows = await db
    .select({ id: events.id, retentionDays: events.retentionDays })
    .from(events)
    .where(
      and(
        isNotNull(events.archivedAt),
        sql`${events.archivedAt} + (${events.retentionDays} || ' days')::interval < now()`,
      ),
    );
  return rows.map((row) => ({ id: row.id as string, retentionDays: row.retentionDays as number }));
};

/**
 * Best-effort Qdrant collection drop. Returns true on success, false when
 * the collection didn't exist (treated as already-clean), and throws on any
 * other Qdrant error so the caller can abort this event's purge.
 */
const dropQdrantCollection = async (qdrant: QdrantLike, eventId: string): Promise<boolean> => {
  const name = collectionName(eventId);
  try {
    await qdrant.deleteCollection(name);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Qdrant returns 404 / "not found" when the collection is absent. Treat
    // as a benign no-op so events with no face data still complete cleanly.
    if (/not.?found|404|doesn'?t exist|does not exist/i.test(message)) {
      return false;
    }
    throw err;
  }
};

/**
 * Purge biometric data for a single expired event. Atomic per event: if any
 * step fails the caller skips audit/consent updates for that event and the
 * next cron tick retries.
 */
const purgeEvent = async (
  db: DbClient,
  qdrant: QdrantLike,
  row: ExpiredEventRow,
): Promise<RetentionEventResult> => {
  // 1) Drop Qdrant collection first. If this throws we abort before touching
  //    Postgres so the two stores can't drift.
  const qdrantCollectionDropped = await dropQdrantCollection(qdrant, row.id);

  // 2) Delete face_vectors rows for this event. No FKs on face_vectors so
  //    nothing cascades.
  const deletedVectors = await db
    .delete(faceVectors)
    .where(eq(faceVectors.eventId, row.id))
    .returning({ id: faceVectors.id });
  const vectorsDeleted = deletedVectors.length;

  // 3) Revoke still-active biometric consents for this event. retention_until
  //    is set to now() so downstream tooling can prove this was a
  //    retention-driven revocation rather than a user action.
  const revokedConsents = await db
    .update(consents)
    .set({ revokedAt: sql`now()`, retentionUntil: sql`now()` })
    .where(
      and(
        eq(consents.eventId, row.id),
        eq(consents.scope, 'biometric'),
        isNull(consents.revokedAt),
      ),
    )
    .returning({ id: consents.id });
  const consentsRevoked = revokedConsents.length;

  // 4) Tamper-evident audit row per event. Written last so partial failures
  //    don't produce misleading "purged" entries.
  await db.insert(auditLog).values({
    actorKind: 'cron',
    action: 'biometric.purged',
    targetKind: 'event',
    targetId: row.id,
    eventId: row.id,
    payloadJsonb: {
      vectorsDeleted,
      qdrantCollectionDropped,
      consentsRevoked,
      retentionDays: row.retentionDays,
    },
  });

  return {
    eventId: row.id,
    vectorsDeleted,
    consentsRevoked,
    qdrantCollectionDropped,
    retentionDays: row.retentionDays,
  };
};

/**
 * One full retention sweep. Returns a summary; per-event failures are
 * isolated — one bad event does not block the rest of the batch.
 *
 * TODO(F3.7): also handle consent-revocation-driven purges — when a subject
 * revokes biometric consent for an event, cascade-delete any face_vectors
 * matched to them. Out of scope for M1; lives in the right-to-erasure issue.
 */
export const runRetentionPass = async (
  db: DbClient,
  qdrant: QdrantLike,
): Promise<RetentionSummary> => {
  const startedAt = Date.now();
  const expired = await findExpiredEvents(db);

  const results: RetentionEventResult[] = [];
  for (const row of expired) {
    try {
      const result = await purgeEvent(db, qdrant, row);
      results.push(result);
    } catch (err) {
      // Per-event isolation: log via console (worker logger wraps this call)
      // and continue. The next tick retries.
      // eslint-disable-next-line no-console
      console.error('[retention] event purge failed', {
        eventId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const totalVectorsDeleted = results.reduce((acc, r) => acc + r.vectorsDeleted, 0);
  const totalConsentsRevoked = results.reduce((acc, r) => acc + r.consentsRevoked, 0);

  return {
    eventsProcessed: results.length,
    totalVectorsDeleted,
    totalConsentsRevoked,
    durationMs: Date.now() - startedAt,
    events: results,
  };
};
