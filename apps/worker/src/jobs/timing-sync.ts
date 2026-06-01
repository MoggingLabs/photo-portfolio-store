// F4.6+ — timing provider sync sweep.
//
// For each enabled event_timing_binding: decrypt the provider credentials,
// resolve the adapter, pull the roster (upsert participants, idempotent on
// (event_id, bib)) and finish events (upsert finish_events, idempotent on
// (event_id, bib, split_name)), then stamp last_synced_at / last_error. A
// provider error is recorded and the binding is retried on the next sweep.
//
// Cadence note: this runs on a single cron interval for simplicity. The tiered
// cadence from F4.6 (roster hourly pre-race / 5min race-day; results every 15s
// during the race window) is a follow-up refinement.

import { type DbClient, schema } from '@pkg/db';
import { decryptCredentials } from '@pkg/integrations';
import type { TimingProvider, TimingProviderAdapter } from '@pkg/integrations';
import { TimingProviderError } from '@pkg/integrations';
import { eq } from 'drizzle-orm';

const { eventTimingBindings, finishEvents } = schema.timing;
const { participants } = schema.participants;

const BATCH_LIMIT = 50;

// Build a provider adapter from decrypted credentials (null = unsupported).
export type TimingAdapterFactory = (
  provider: TimingProvider,
  apiKey: string,
) => TimingProviderAdapter | null;

export interface TimingSyncDeps {
  masterKey: string;
  adapterFactory: TimingAdapterFactory;
  now?: () => Date;
}

export interface TimingSyncResult {
  bindingsProcessed: number;
  rosterUpserted: number;
  finishUpserted: number;
  errors: Array<{ bindingId: string; error: string }>;
}

interface BindingRow {
  id: string;
  eventId: string;
  provider: TimingProvider;
  externalEventId: string;
  credentialsEncrypted: string;
  lastSyncedAt: Date | null;
}

export const runTimingSync = async (
  db: DbClient,
  deps: TimingSyncDeps,
): Promise<TimingSyncResult> => {
  const now = deps.now ?? (() => new Date());
  const bindings = (await db
    .select({
      id: eventTimingBindings.id,
      eventId: eventTimingBindings.eventId,
      provider: eventTimingBindings.provider,
      externalEventId: eventTimingBindings.externalEventId,
      credentialsEncrypted: eventTimingBindings.credentialsEncrypted,
      lastSyncedAt: eventTimingBindings.lastSyncedAt,
    })
    .from(eventTimingBindings)
    .where(eq(eventTimingBindings.enabled, true))
    .limit(BATCH_LIMIT)) as BindingRow[];

  const result: TimingSyncResult = {
    bindingsProcessed: 0,
    rosterUpserted: 0,
    finishUpserted: 0,
    errors: [],
  };

  for (const b of bindings) {
    result.bindingsProcessed += 1;
    try {
      const apiKey = decryptCredentials(b.credentialsEncrypted, deps.masterKey);
      const adapter = deps.adapterFactory(b.provider, apiKey);
      if (!adapter) {
        await recordError(db, b.id, `unsupported provider ${b.provider}`, now());
        result.errors.push({ bindingId: b.id, error: 'unsupported_provider' });
        continue;
      }

      const roster = await adapter.pullRoster(b.externalEventId);
      for (const entry of roster) {
        const name = `${entry.firstName} ${entry.lastName}`.trim();
        // Conflict resolution (F4.7): the provider is authoritative for name,
        // but an existing email (e.g. from a CSV import) is kept when the
        // provider has none — so only overwrite email when one is supplied.
        await db
          .insert(participants)
          .values({
            eventId: b.eventId,
            bib: entry.bib,
            name,
            email: entry.email ?? null,
            transponderId: entry.transponderId ?? null,
          })
          .onConflictDoUpdate({
            target: [participants.eventId, participants.bib],
            set: {
              name,
              ...(entry.email ? { email: entry.email } : {}),
              ...(entry.transponderId ? { transponderId: entry.transponderId } : {}),
              updatedAt: now(),
            },
          });
        result.rosterUpserted += 1;
      }

      const finishes = await adapter.pullFinishEvents(
        b.externalEventId,
        b.lastSyncedAt ? { since: b.lastSyncedAt } : {},
      );
      for (const f of finishes) {
        await db
          .insert(finishEvents)
          .values({
            eventId: b.eventId,
            bib: f.bib,
            splitName: f.splitName,
            gunTimeMs: f.gunTimeMs ?? null,
            chipTimeMs: f.chipTimeMs ?? null,
            recordedAt: f.recordedAt,
            source: b.provider,
            rawPayloadJson: f.raw,
          })
          .onConflictDoUpdate({
            target: [finishEvents.eventId, finishEvents.bib, finishEvents.splitName],
            set: {
              gunTimeMs: f.gunTimeMs ?? null,
              chipTimeMs: f.chipTimeMs ?? null,
              recordedAt: f.recordedAt,
              rawPayloadJson: f.raw,
            },
          });
        result.finishUpserted += 1;
        // NOTE: a confirmed finish event + photo match should fan a
        // photos.ready_for_bib notification (F4.12). Wired with #95.
      }

      await db
        .update(eventTimingBindings)
        .set({ lastSyncedAt: now(), lastError: null, syncRequestedAt: null, updatedAt: now() })
        .where(eq(eventTimingBindings.id, b.id));
    } catch (err) {
      const msg =
        err instanceof TimingProviderError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      await recordError(db, b.id, msg, now());
      result.errors.push({ bindingId: b.id, error: msg });
    }
  }

  return result;
};

const recordError = (db: DbClient, id: string, error: string, now: Date): Promise<unknown> =>
  db
    .update(eventTimingBindings)
    .set({ lastError: error, updatedAt: now })
    .where(eq(eventTimingBindings.id, id));
