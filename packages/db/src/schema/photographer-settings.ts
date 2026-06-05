// Photographer settings context — per-photographer preferences (F5.5).
// All tables in the Postgres `app` schema.
//
// One row per photographer (keyed by the user id). Holds the quality auto-reject
// configuration: when enabled, the quality worker hides photos scoring below the
// threshold from buyers until the photographer overrides. Default disabled —
// false positives are costly, so auto-reject is opt-in.

import { sql } from 'drizzle-orm';
import { boolean, numeric, pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core';

const app = pgSchema('app');

export const photographerSettings = app.table('photographer_settings', {
  // refs users.id — cross-context, no FK. One settings row per photographer.
  photographerUserId: uuid('photographer_user_id').primaryKey(),
  // Opt-in auto-reject of below-threshold photos at ingest.
  qualityFilterEnabled: boolean('quality_filter_enabled').notNull().default(false),
  // 0-1 cutoff; a photo scoring below this is auto-rejected when the filter is on.
  qualityThreshold: numeric('quality_threshold', { precision: 3, scale: 2 })
    .notNull()
    .default('0.50'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export const tables = {
  photographerSettings,
};
