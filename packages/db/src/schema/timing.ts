// Timing context — per-event provider bindings (F4.6+) + finish events.
// All tables in the Postgres `app` schema.
//
// A binding ties an event to an external race at a timing provider, with the
// provider credentials stored envelope-encrypted (per binding, since timing
// accounts are typically per-race). finish_events records each result, deduped
// on (event_id, bib, split_name) so re-polling is idempotent.

import { sql } from 'drizzle-orm';
import {
  bigint,
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

export const timingProvider = app.enum('timing_provider', ['runsignup', 'chronotrack', 'mylaps']);

export const eventTimingBindings = app.table(
  'event_timing_bindings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK.
    eventId: uuid('event_id').notNull(),
    provider: timingProvider('provider').notNull(),
    // The provider's race/event id.
    externalEventId: text('external_event_id').notNull(),
    // Envelope-encrypted provider credentials (never returned).
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    syncRequestedAt: timestamp('sync_requested_at', { withTimezone: true, mode: 'date' }),
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
    eventProviderIdx: uniqueIndex('event_timing_bindings_event_provider_idx').on(
      table.eventId,
      table.provider,
    ),
    enabledIdx: index('event_timing_bindings_enabled_idx').on(table.enabled),
  }),
);

export const finishEvents = app.table(
  'finish_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid('event_id').notNull(),
    bib: text('bib').notNull(),
    splitName: text('split_name').notNull().default('finish'),
    gunTimeMs: bigint('gun_time_ms', { mode: 'number' }),
    chipTimeMs: bigint('chip_time_ms', { mode: 'number' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull(),
    source: text('source').notNull(),
    rawPayloadJson: jsonb('raw_payload_json'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Idempotent ingest: one row per (event, bib, split).
    eventBibSplitIdx: uniqueIndex('finish_events_event_bib_split_idx').on(
      table.eventId,
      table.bib,
      table.splitName,
    ),
    eventBibIdx: index('finish_events_event_bib_idx').on(table.eventId, table.bib),
  }),
);

export const tables = {
  eventTimingBindings,
  finishEvents,
};
