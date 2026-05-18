// Events context — events, members, settings, FTP credentials, rosters.
// All tables in the Postgres `app` schema. Cross-context FKs stay as plain
// uuid columns; application code enforces.

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

// ---------- Enums ----------

export const eventStatus = app.enum('event_status', ['draft', 'published', 'archived']);

export const eventMemberRole = app.enum('event_member_role', [
  'organizer',
  'photographer',
  'assistant',
]);

// ---------- events ----------

export const events = app.table(
  'events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs orgs.id (cross-context — enforced in app code)
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    eventDate: date('event_date', { mode: 'date' }).notNull(),
    location: text('location'),
    timezone: text('timezone').notNull().default('UTC'),
    status: eventStatus('status').notNull().default('draft'),
    // F1.24 — face-search gate
    allowFaceSearch: boolean('allow_face_search').notNull().default(true),
    // F1.35 — retention cron driver
    retentionDays: integer('retention_days').notNull().default(30),
    // ISO 4217
    currency: text('currency').notNull().default('USD'),
    // refs photos.id (cross-context — enforced in app code)
    coverPhotoId: uuid('cover_photo_id'),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    }),
    archivedAt: timestamp('archived_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // App code updates updated_at on change.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    orgSlugUnique: uniqueIndex('events_org_slug_unique').on(table.orgId, table.slug),
    statusDateIdx: index('events_status_date_idx').on(table.status, table.eventDate),
  }),
);

// ---------- event_members ----------

export const eventMembers = app.table(
  'event_members',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    // refs users.id (cross-context — enforced in app code)
    userId: uuid('user_id').notNull(),
    role: eventMemberRole('role').notNull(),
    // e.g. 33.33 — sum across photographers <= 100; enforced by app code (F2.10).
    splitPct: numeric('split_pct', { precision: 5, scale: 2 }).notNull().default('0.00'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.eventId, table.userId] }),
    userIdx: index('event_members_user_idx').on(table.userId),
  }),
);

// ---------- event_settings ----------

export const eventSettings = app.table('event_settings', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  watermarkText: text('watermark_text'),
  watermarkOpacity: numeric('watermark_opacity', { precision: 3, scale: 2 })
    .notNull()
    .default('0.40'),
  previewMaxPixels: integer('preview_max_pixels').notNull().default(1600),
  downloadExpiryHours: integer('download_expiry_hours').notNull().default(72),
  // F1.24 default face similarity threshold
  faceThreshold: numeric('face_threshold', { precision: 3, scale: 2 }).notNull().default('0.45'),
  allowAnonymousBrowse: boolean('allow_anonymous_browse').notNull().default(true),
  hideBuyButton: boolean('hide_buy_button').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  // App code updates updated_at on change.
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// ---------- event_ftp_credentials ----------
// F1.16 — rotated per event.

export const eventFtpCredentials = app.table(
  'event_ftp_credentials',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    username: text('username').notNull().unique(),
    // argon2id hash of generated password
    passwordHash: text('password_hash').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    lookupIdx: index('event_ftp_credentials_lookup_idx').on(
      table.eventId,
      table.revokedAt,
      table.expiresAt,
    ),
  }),
);

// ---------- event_roster_entries ----------
// F4.5 — CSV-imported bib/name/email mapping. Schema lands here; import
// endpoint lives in M4.

export const eventRosterEntries = app.table(
  'event_roster_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    bib: text('bib').notNull(),
    name: text('name'),
    // Lowered for case-insensitive lookup. Original-case preservation can be
    // added later if needed.
    emailLower: text('email_lower'),
    // id from race-timing system
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    eventBibUnique: uniqueIndex('event_roster_entries_event_bib_unique').on(
      table.eventId,
      table.bib,
    ),
    eventEmailIdx: index('event_roster_entries_event_email_idx').on(
      table.eventId,
      table.emailLower,
    ),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  events,
  eventMembers,
  eventSettings,
  eventFtpCredentials,
  eventRosterEntries,
};
