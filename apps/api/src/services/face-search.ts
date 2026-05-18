// F1.24 — selfie-based face search service.
//
// End-to-end flow:
//   1. verifyConsent (F1.33 gate)
//   2. event + event_settings check (status='published', allow_face_search=true)
//   3. magic-byte validation of selfie buffer (jpeg/png/heic, <=8MiB)
//   4. embedSelfie via inference HTTP call (buffer never persisted)
//   5. choose largest face if multiple detected
//   6. Qdrant ANN search using the event's per-event collection
//   7. hydrate photos + signed preview URLs
//   8. insert search_sessions + search_matches rows
//   9. incrementSearchUsage on the consent
//  10. writeAudit biometric.search.face
//
// The selfie buffer is ONLY held in memory inside this function and the
// inference client. No fs.write, no S3 put, no log of bytes. A test in
// apps/api/test/face-search.service.test.ts asserts this with a spy.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, inArray } from 'drizzle-orm';

import { writeAudit } from '../lib/audit.js';
import {
  type EmbedSelfieResult,
  InferenceUnavailableError,
  embedSelfie as defaultEmbedSelfie,
} from '../lib/inference-client.js';
import { createPreviewUrlCache, getPhotoUrlsBatch } from '../lib/preview-urls.js';
import { type QdrantSearchHit, searchFaces as defaultSearchFaces } from '../lib/qdrant-client.js';
import {
  CONSENT_SEARCH_QUOTA,
  type VerifyFailureReason,
  incrementSearchUsage,
  verifyConsent,
} from './consents.js';

const { events, eventSettings } = schema.events.tables;
const { photos } = schema.photos.tables;
const { faceVectors, searchSessions, searchMatches } = schema.search.tables;

// ---------- Constants ----------

const MAX_SELFIE_BYTES = 8 * 1024 * 1024;
const QDRANT_LIMIT = 50;

// Magic-byte detection — content-type from clients is not trustworthy.
const isJpeg = (b: Buffer): boolean =>
  b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer): boolean =>
  b.length >= 8 &&
  b[0] === 0x89 &&
  b[1] === 0x50 &&
  b[2] === 0x4e &&
  b[3] === 0x47 &&
  b[4] === 0x0d &&
  b[5] === 0x0a &&
  b[6] === 0x1a &&
  b[7] === 0x0a;
// HEIC: ISO BMFF, brand 'heic'/'heix'/'heif'/'mif1' inside ftyp box at offset 4.
const isHeic = (b: Buffer): boolean => {
  if (b.length < 12) return false;
  if (b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70) return false;
  const brand = b.slice(8, 12).toString('ascii');
  return ['heic', 'heix', 'heif', 'mif1', 'msf1'].includes(brand);
};

const detectContentType = (buf: Buffer): 'image/jpeg' | 'image/png' | 'image/heic' | null => {
  if (isJpeg(buf)) return 'image/jpeg';
  if (isPng(buf)) return 'image/png';
  if (isHeic(buf)) return 'image/heic';
  return null;
};

// ---------- Errors ----------

export type FaceSearchErrorCode =
  | 'consent_required'
  | 'consent_invalid'
  | 'not_found'
  | 'selfie_too_large'
  | 'unsupported_media_type'
  | 'no_face_detected'
  | 'inference_unavailable'
  | 'invalid_request';

export class FaceSearchError extends Error {
  constructor(
    public readonly code: FaceSearchErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FaceSearchError';
  }
}

const mapVerifyFailureToError = (reason: VerifyFailureReason): FaceSearchError => {
  switch (reason) {
    case 'not_found':
      return new FaceSearchError('consent_invalid', 'consent not found');
    case 'wrong_event':
      return new FaceSearchError('consent_invalid', 'consent does not cover this event');
    case 'expired':
      return new FaceSearchError('consent_invalid', 'consent expired');
    case 'revoked':
      return new FaceSearchError('consent_invalid', 'consent revoked');
    case 'quota_exhausted':
      return new FaceSearchError('consent_invalid', 'consent search quota exhausted');
    case 'bind_mismatch':
      return new FaceSearchError('consent_invalid', 'consent binding mismatch');
    default:
      return new FaceSearchError('consent_invalid', 'consent invalid');
  }
};

// ---------- Types ----------

export interface FaceSearchInput {
  eventId: string;
  consentId: string;
  selfieBytes: Buffer;
  selfieContentType?: string;
  ipHash?: string;
  userAgent?: string;
}

export interface FaceSearchMatch {
  photoId: string;
  score: number;
  rank: number;
  thumbUrl: string | null;
  previewUrl: string | null;
}

export interface FaceSearchResult {
  sessionId: string;
  matches: FaceSearchMatch[];
  warnings: string[];
  consent: {
    searchesRemaining: number;
    expiresAt: string;
  };
}

export interface FaceSearchDeps {
  embedSelfie?: (
    buf: Buffer,
    opts?: { filename?: string; contentType?: string },
  ) => Promise<EmbedSelfieResult>;
  searchFaces?: (
    eventId: string,
    vector: number[],
    opts: { limit: number; threshold: number },
  ) => Promise<QdrantSearchHit[]>;
}

// ---------- Helpers ----------

interface EventGate {
  thresholdNumeric: number;
}

const loadEventGate = async (db: DbClient, eventId: string): Promise<EventGate | null> => {
  const rows = await db
    .select({
      status: events.status,
      allowFaceSearch: events.allowFaceSearch,
      threshold: eventSettings.faceThreshold,
    })
    .from(events)
    .leftJoin(eventSettings, eq(eventSettings.eventId, events.id))
    .where(eq(events.id, eventId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.status !== 'published') return null;
  if (row.allowFaceSearch !== true) return null;
  const threshold = row.threshold == null ? 0.45 : Number(row.threshold);
  return { thresholdNumeric: threshold };
};

const bboxArea = (bbox: [number, number, number, number]): number =>
  Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);

const pickLargestFace = (
  faces: EmbedSelfieResult['vectors'],
): EmbedSelfieResult['vectors'][number] => {
  const [first, ...rest] = faces;
  if (!first) throw new FaceSearchError('no_face_detected', 'no face detected');
  let best = first;
  for (const f of rest) {
    if (bboxArea(f.bbox) > bboxArea(best.bbox)) best = f;
  }
  return best;
};

// ---------- runFaceSearch ----------

export const runFaceSearch = async (
  db: DbClient,
  input: FaceSearchInput,
  deps: FaceSearchDeps = {},
): Promise<FaceSearchResult> => {
  const start = Date.now();

  // 1. Consent verify (F1.33).
  const verifyResult = await verifyConsent(db, input.consentId, input.eventId, {
    ipHash: input.ipHash,
    userAgent: input.userAgent,
  });
  if (!verifyResult.ok) {
    await writeAudit(db, {
      action: 'biometric.search.face.denied',
      actorKind: 'system',
      targetKind: 'event',
      targetId: input.eventId,
      eventId: input.eventId,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
      payload: { reason: verifyResult.reason, consentId: input.consentId },
    });
    throw mapVerifyFailureToError(verifyResult.reason);
  }
  const consent = verifyResult.consent;

  // 2. Event + face-search gate (anti-enumeration: same 404 either way).
  const gate = await loadEventGate(db, input.eventId);
  if (!gate) {
    await writeAudit(db, {
      action: 'biometric.search.face.denied',
      actorKind: 'system',
      targetKind: 'event',
      targetId: input.eventId,
      eventId: input.eventId,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
      payload: { reason: 'event_not_available', consentId: input.consentId },
    });
    throw new FaceSearchError('not_found', 'event not available');
  }

  // 3. Selfie validation.
  if (input.selfieBytes.length > MAX_SELFIE_BYTES) {
    throw new FaceSearchError('selfie_too_large', 'selfie exceeds 8 MiB');
  }
  const detected = detectContentType(input.selfieBytes);
  if (!detected) {
    throw new FaceSearchError('unsupported_media_type', 'selfie must be jpeg, png, or heic');
  }

  // 4. Embed.
  const embedFn = deps.embedSelfie ?? defaultEmbedSelfie;
  let embed: EmbedSelfieResult;
  try {
    embed = await embedFn(input.selfieBytes, {
      filename: 'selfie.bin',
      contentType: detected,
    });
  } catch (err) {
    if (err instanceof InferenceUnavailableError) {
      throw new FaceSearchError('inference_unavailable', err.message);
    }
    throw err;
  }

  // 5. Multi-face handling.
  if (!embed.vectors || embed.vectors.length === 0) {
    throw new FaceSearchError('no_face_detected', 'no face detected');
  }
  const warnings: string[] = [];
  if (embed.vectors.length > 1) warnings.push('multi_face_detected');
  const chosen = pickLargestFace(embed.vectors);

  // 6. Qdrant search.
  const searchFn = deps.searchFaces ?? defaultSearchFaces;
  const hits = await searchFn(input.eventId, chosen.embedding, {
    limit: QDRANT_LIMIT,
    threshold: gate.thresholdNumeric,
  });

  // 7. Hydrate to photos.
  const hitMap = new Map<string, number>();
  for (const h of hits) hitMap.set(String(h.id), h.score);

  let matches: FaceSearchMatch[] = [];
  if (hitMap.size > 0) {
    const qdrantIds = Array.from(hitMap.keys());
    const vectorRows = await db
      .select({
        photoId: faceVectors.photoId,
        qdrantPointId: faceVectors.qdrantPointId,
      })
      .from(faceVectors)
      .where(
        and(eq(faceVectors.eventId, input.eventId), inArray(faceVectors.qdrantPointId, qdrantIds)),
      );

    const photoIds = Array.from(new Set(vectorRows.map((r) => r.photoId)));
    if (photoIds.length > 0) {
      const photoRows = await db
        .select({ id: photos.id, status: photos.status, hidden: photos.hidden })
        .from(photos)
        .where(inArray(photos.id, photoIds));

      const viable = new Set(
        photoRows.filter((p) => p.status === 'ready' && p.hidden === false).map((p) => p.id),
      );

      // Pick best score per photoId.
      const bestByPhoto = new Map<string, number>();
      for (const v of vectorRows) {
        if (!viable.has(v.photoId)) continue;
        const score = hitMap.get(v.qdrantPointId) ?? 0;
        const prev = bestByPhoto.get(v.photoId);
        if (prev === undefined || score > prev) bestByPhoto.set(v.photoId, score);
      }

      const ranked = Array.from(bestByPhoto.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([photoId, score], idx) => ({ photoId, score, rank: idx + 1 }));

      const cache = createPreviewUrlCache();
      const urls = await getPhotoUrlsBatch(
        db,
        ranked.map((r) => r.photoId),
        cache,
      );

      matches = ranked.map((r) => {
        const u = urls.get(r.photoId);
        return {
          photoId: r.photoId,
          score: r.score,
          rank: r.rank,
          thumbUrl: u?.thumbUrl ?? null,
          previewUrl: u?.previewUrl ?? null,
        };
      });
    }
  }

  const latencyMs = Date.now() - start;

  // 8. Insert session + matches.
  const sessionInserted = await db
    .insert(searchSessions)
    .values({
      eventId: input.eventId,
      consentId: consent.id,
      searchKind: 'face',
      queryText: null,
      matchesCount: matches.length,
      latencyMs,
      clientIpHash: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning({ id: searchSessions.id });
  const sessionRow = sessionInserted[0];
  if (!sessionRow) throw new Error('search_sessions insert returned no row');
  const sessionId = sessionRow.id;

  if (matches.length > 0) {
    await db.insert(searchMatches).values(
      matches.map((m) => ({
        sessionId,
        photoId: m.photoId,
        score: m.score.toFixed(4),
        source: 'face' as const,
        rank: m.rank,
      })),
    );
  }

  // 9. Increment quota (atomic).
  const used = await incrementSearchUsage(db, consent.id);
  const searchesRemaining = Math.max(0, CONSENT_SEARCH_QUOTA - used);

  // 10. Audit.
  await writeAudit(db, {
    action: 'biometric.search.face',
    actorKind: 'user',
    targetKind: 'event',
    targetId: input.eventId,
    eventId: input.eventId,
    ipHash: input.ipHash,
    userAgent: input.userAgent,
    payload: {
      consentId: consent.id,
      sessionId,
      matchesCount: matches.length,
      threshold: gate.thresholdNumeric,
      latencyMs,
      warnings,
      modelVersion: embed.modelVersion,
    },
  });

  return {
    sessionId,
    matches,
    warnings,
    consent: {
      searchesRemaining,
      expiresAt: consent.expiresAt
        ? consent.expiresAt.toISOString()
        : new Date(Date.now()).toISOString(),
    },
  };
};
