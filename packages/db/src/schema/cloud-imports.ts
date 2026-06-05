// Cloud-import context — Google Drive / Dropbox folder imports (F4.4).
// All tables in the Postgres `app` schema.
//
// The OAuth connection (access + refresh token) lives per-org in
// integration_configs (type 'gdrive'/'dropbox'). A cloud_imports row binds one
// remote folder to one event and tracks the sync's progress. cloud_import_files
// is a per-file state machine: the unique (event_id, content_hash) index prevents
// duplicate rows, and `status` drives resume — a file is only marked 'imported'
// after its ingest job is enqueued, so a crash mid-import retries cleanly.

import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

export const cloudImportProvider = app.enum('cloud_import_provider', ['gdrive', 'dropbox']);

export const cloudImportStatus = app.enum('cloud_import_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);

export const cloudImportFileStatus = app.enum('cloud_import_file_status', [
  'pending',
  'imported',
  'failed',
]);

export const cloudImports = app.table(
  'cloud_imports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK. The folder is bound to one event.
    eventId: uuid('event_id').notNull(),
    // Denormalized from events.org_id so the worker can resolve the org's
    // integration_configs(org_id, provider) token without an extra join.
    orgId: uuid('org_id').notNull(),
    // The user who created the import; used as photos.photographer_user_id.
    photographerUserId: uuid('photographer_user_id').notNull(),
    provider: cloudImportProvider('provider').notNull(),
    remoteFolderId: text('remote_folder_id').notNull(),
    status: cloudImportStatus('status').notNull().default('pending'),
    // Null until the worker's first folder listing completes.
    totalFiles: integer('total_files'),
    importedFiles: integer('imported_files').notNull().default(0),
    failedFiles: integer('failed_files').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // The worker sweep selects pending/running imports.
    statusIdx: index('cloud_imports_status_idx').on(table.status),
    // List an event's imports.
    eventIdx: index('cloud_imports_event_idx').on(table.eventId),
  }),
);

export const cloudImportFiles = app.table(
  'cloud_import_files',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs cloud_imports.id — cross-context, no FK.
    cloudImportId: uuid('cloud_import_id').notNull(),
    remoteFileId: text('remote_file_id').notNull(),
    // Namespaced provider content hash (e.g. 'gdrive:md5:<hex>',
    // 'dropbox:<content_hash>'), or 'gdrive:fileid:<id>' when no hash is exposed.
    contentHash: text('content_hash').notNull(),
    // Listing snapshot, so ticks after the first do not re-list the folder.
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    // From provider metadata; null only on rows pre-failed for a missing size.
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    // Set once the photos row is created and the ingest job is enqueued.
    photoId: uuid('photo_id'),
    status: cloudImportFileStatus('status').notNull().default('pending'),
    // Bounded retry counter for transient download/upload failures.
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Dedup / resume: one row per (import, content hash). Also serves the
    // import-scoped status scans the worker runs each tick.
    importHashIdx: uniqueIndex('cloud_import_files_import_hash_idx').on(
      table.cloudImportId,
      table.contentHash,
    ),
  }),
);

export const tables = {
  cloudImports,
  cloudImportFiles,
};
