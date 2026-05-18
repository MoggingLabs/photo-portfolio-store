// Search context — face vectors (metadata only; embeddings live in Qdrant),
// bib OCR tags, quality flags, search sessions, and search matches.
// All tables in the `app` schema. Cross-context FKs stay as plain uuid columns.
// Selfie images are NEVER persisted; only the search_sessions row + consent_id.

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
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

export const bibSource = app.enum('bib_source', ['ocr', 'manual', 'roster_match']);

export const qualityFlagKind = app.enum('quality_flag_kind', [
  'blur',
  'eyes_closed',
  'near_duplicate',
  'underexposed',
  'overexposed',
]);

export const searchKind = app.enum('search_kind', ['bib', 'name', 'face', 'text']);

export const matchSource = app.enum('match_source', ['bib', 'name', 'face', 'text', 'hybrid']);

export const matchFeedback = app.enum('match_feedback', ['unrated', 'correct', 'wrong', 'missing']);

// ---------- face_vectors ----------
// Metadata for each detected face. The 512-d embedding lives in Qdrant; this
// table stores the bbox + Qdrant point ID for cross-DB join. Compensating
// transaction pattern: delete Qdrant point first, then this row (F1.35).

export const faceVectors = app.table(
  'face_vectors',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs photos.id — cross-context, no FK.
    photoId: uuid('photo_id').notNull(),
    // refs events.id — cross-context, no FK. Denormalized for fast
    // event-scoped purge (F1.35 retention worker).
    eventId: uuid('event_id').notNull(),
    bboxX: integer('bbox_x').notNull(),
    bboxY: integer('bbox_y').notNull(),
    bboxWidth: integer('bbox_width').notNull(),
    bboxHeight: integer('bbox_height').notNull(),
    // Detector confidence, e.g. 0.987.
    detectorScore: numeric('detector_score', {
      precision: 4,
      scale: 3,
    }).notNull(),
    // UUID string used as the Qdrant point ID — the cross-DB join key.
    qdrantPointId: text('qdrant_point_id').notNull(),
    // e.g. 'insightface-buffalo_l-1.0' — for re-embedding migrations.
    modelVersion: text('model_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // One-to-one with Qdrant; required for compensating-delete lookups.
    qdrantPointIdIdx: uniqueIndex('face_vectors_qdrant_point_id_idx').on(table.qdrantPointId),
    // F1.35 retention purge per event.
    eventIdx: index('face_vectors_event_idx').on(table.eventId),
    // "All faces in this photo".
    photoIdx: index('face_vectors_photo_idx').on(table.photoId),
  }),
);

// ---------- bib_tags ----------
// OCR results per F1.19. Bib number stored as captured; case-insensitive
// lookup expected via lower(bib_number).

export const bibTags = app.table(
  'bib_tags',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs photos.id — cross-context, no FK.
    photoId: uuid('photo_id').notNull(),
    // refs events.id — cross-context, no FK. Denormalized for event scope.
    eventId: uuid('event_id').notNull(),
    bibNumber: text('bib_number').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
    source: bibSource('source').notNull().default('ocr'),
    // Region of the bib in the photo (e.g. { x, y, w, h }).
    bboxJsonb: jsonb('bbox_jsonb'),
    modelVersion: text('model_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Primary lookup: bibs for an event by number.
    eventBibIdx: index('bib_tags_event_bib_idx').on(table.eventId, table.bibNumber),
    // "All bibs in this photo".
    photoIdx: index('bib_tags_photo_idx').on(table.photoId),
  }),
);

// ---------- quality_flags ----------
// Inference-derived quality signals per F3.12. Re-runs overwrite; one record
// per (photo, flag) enforced via unique index.

export const qualityFlags = app.table(
  'quality_flags',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs photos.id — cross-context, no FK.
    photoId: uuid('photo_id').notNull(),
    flag: qualityFlagKind('flag').notNull(),
    score: numeric('score', { precision: 4, scale: 3 }).notNull(),
    // e.g. {"duplicate_of_photo_id": "..."} for near_duplicate.
    metadataJsonb: jsonb('metadata_jsonb'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // One record per flag per photo — re-runs overwrite.
    photoFlagIdx: uniqueIndex('quality_flags_photo_flag_idx').on(table.photoId, table.flag),
  }),
);

// ---------- search_sessions ----------
// F1.24 — selfie searches and other queries. The selfie image is NEVER
// persisted; the face embedding is transient. Only this row + consent_id
// remain as the audit trail (gated by F1.33).

export const searchSessions = app.table(
  'search_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK.
    eventId: uuid('event_id').notNull(),
    // refs consents.id — cross-context, no FK. Required per F1.33 gate.
    consentId: uuid('consent_id').notNull(),
    searchKind: searchKind('search_kind').notNull(),
    // For name/text queries. NOT used for face — embeddings are transient
    // and never persisted.
    queryText: text('query_text'),
    matchesCount: integer('matches_count').notNull().default(0),
    latencyMs: integer('latency_ms'),
    // sha256(IP) — for rate limiting + abuse detection. Never raw IP.
    clientIpHash: text('client_ip_hash'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Event-scoped session timeline.
    eventCreatedIdx: index('search_sessions_event_created_idx').on(table.eventId, table.createdAt),
    // "All searches under this consent".
    consentIdx: index('search_sessions_consent_idx').on(table.consentId),
  }),
);

// ---------- search_matches ----------
// Results of a search session — feeds the "did we miss any" feedback loop
// per F5.11.

export const searchMatches = app.table(
  'search_matches',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => searchSessions.id, { onDelete: 'cascade' }),
    // refs photos.id — cross-context, no FK.
    photoId: uuid('photo_id').notNull(),
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    source: matchSource('source').notNull(),
    // Position in the result list (1-based).
    rank: integer('rank').notNull(),
    feedback: matchFeedback('feedback').notNull().default('unrated'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.photoId] }),
    // "What searches found me" — reverse lookup per photo.
    photoSourceIdx: index('search_matches_photo_source_idx').on(table.photoId, table.source),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  faceVectors,
  bibTags,
  qualityFlags,
  searchSessions,
  searchMatches,
};
