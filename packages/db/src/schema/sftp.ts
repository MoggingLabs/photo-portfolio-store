// SFTP ingest context — per-event SFTP accounts (F4.2) + an upload dedup log.
// All tables in the Postgres `app` schema.
//
// One account per event (chrooted home, key-based auth only). The watcher
// records each stable upload in sftp_uploads keyed by content hash so resumed /
// duplicate uploads do not enqueue a second ingest job.

import { sql } from 'drizzle-orm';
import { pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const app = pgSchema('app');

export const sftpAccountStatus = app.enum('sftp_account_status', ['active', 'disabled']);

export const sftpAccounts = app.table(
  'sftp_accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK. One account per event.
    eventId: uuid('event_id').notNull(),
    systemUsername: text('system_username').notNull(),
    publicKeyFingerprint: text('public_key_fingerprint').notNull(),
    chrootPath: text('chroot_path').notNull(),
    status: sftpAccountStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    lastRotatedAt: timestamp('last_rotated_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    eventIdx: uniqueIndex('sftp_accounts_event_idx').on(table.eventId),
    usernameIdx: uniqueIndex('sftp_accounts_username_idx').on(table.systemUsername),
  }),
);

export const sftpUploads = app.table(
  'sftp_uploads',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid('event_id').notNull(),
    contentHash: text('content_hash').notNull(),
    path: text('path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Dedup: one ingest per (event, content hash).
    eventHashIdx: uniqueIndex('sftp_uploads_event_hash_idx').on(table.eventId, table.contentHash),
  }),
);

export const tables = {
  sftpAccounts,
  sftpUploads,
};
