// F1.22 — face:detect-embed worker.
//
// Pipeline per photo:
//   1. Load the photo row (need eventId + originalObjectKey).
//   2. Ensure the per-event Qdrant collection exists.
//   3. Download the original from R2 into memory.
//   4. POST to the Python inference service for detection + embeddings.
//   5. For each detected face:
//        - INSERT a `face_vectors` row (eventId denormalized for purge).
//        - UPSERT the embedding to Qdrant under the same UUID (row.id ===
//          Qdrant point id).
//   6. Audit log `biometric.face.indexed`.
//
// Privacy notes:
//   - The image buffer is never persisted beyond the existing originals
//     bucket. It is released as soon as inference returns.
//   - The 512-d embedding lives ONLY in Qdrant; we store the bbox, score, and
//     point id in Postgres for cross-DB joins and compensating deletes.
//   - On final retry failure, the photo is marked `status='failed'` so the
//     dashboard surfaces it.

import { randomUUID as cryptoRandomUUID } from 'node:crypto';

import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { type DbClient, schema } from '@pkg/db';
import * as Sentry from '@sentry/node';
import type { Job, Processor } from 'bullmq';
import { sql } from 'drizzle-orm';

import { writeWorkerAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { detectAndEmbed as defaultDetectAndEmbed } from '../lib/inference-client.js';
import { logger } from '../lib/logger.js';
import {
  ensureCollection as defaultEnsureCollection,
  upsertFaceVectors as defaultUpsertFaceVectors,
} from '../lib/qdrant.js';
import { buckets, getS3 } from '../lib/storage.js';
import type { FaceJobData } from '../queues/face.js';

const { photos } = schema.photos;
const { faceVectors } = schema.search;

export interface FaceProcessorDeps {
  db?: DbClient;
  s3?: S3Client;
  bucket?: string;
  detectAndEmbed?: typeof defaultDetectAndEmbed;
  ensureCollection?: typeof defaultEnsureCollection;
  upsertFaceVectors?: typeof defaultUpsertFaceVectors;
  // randomUUID injection lets tests assert deterministic point ids.
  randomUUID?: () => string;
}

export type FaceProcessResult =
  | { status: 'indexed'; faces: number }
  | { status: 'skipped'; reason: string };

const streamToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body) throw new Error('storage GET returned empty body');

  // Newer AWS SDK SmithyMessage body shape exposes `transformToByteArray()`.
  const withTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withTransform.transformToByteArray === 'function') {
    const bytes = await withTransform.transformToByteArray();
    return Buffer.from(bytes);
  }

  // Fall back to Node Readable.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const downloadOriginal = async (
  s3: S3Client,
  bucket: string,
  objectKey: string,
): Promise<Buffer> => {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  return streamToBuffer(out.Body);
};

/**
 * Pure function form for unit tests — every dependency is injectable.
 */
export const processFaceJob = async (
  job: Job<FaceJobData>,
  deps: FaceProcessorDeps = {},
): Promise<FaceProcessResult> => {
  const dbClient = deps.db ?? defaultDb;
  const s3 = deps.s3 ?? getS3();
  const bucket = deps.bucket ?? buckets.originals;
  const detectAndEmbed = deps.detectAndEmbed ?? defaultDetectAndEmbed;
  const ensureCollection = deps.ensureCollection ?? defaultEnsureCollection;
  const upsertFaceVectors = deps.upsertFaceVectors ?? defaultUpsertFaceVectors;
  const randomUUID = deps.randomUUID ?? cryptoRandomUUID;

  const { photoId } = job.data;
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 3;

  try {
    const rows = await dbClient
      .select({
        id: photos.id,
        eventId: photos.eventId,
        objectKey: photos.originalObjectKey,
        contentType: photos.contentType,
        status: photos.status,
      })
      .from(photos)
      .where(sql`${photos.id} = ${photoId}`)
      .limit(1);

    const row = rows[0];
    if (!row) {
      logger.warn({ photoId }, 'face: photo not found, skipping');
      return { status: 'skipped', reason: 'not_found' };
    }
    if (row.status === 'takedown' || row.status === 'hidden') {
      logger.warn({ photoId, status: row.status }, 'face: photo not visible, skipping');
      return { status: 'skipped', reason: `status:${row.status}` };
    }

    await ensureCollection(row.eventId);

    // Download → infer → release. The buffer is dropped after the await; GC
    // will reclaim it on the next cycle. We do NOT persist or log raw bytes.
    const imageBytes = await downloadOriginal(s3, bucket, row.objectKey);
    const inference = await detectAndEmbed(imageBytes, {
      filename: `${photoId}.bin`,
      contentType: row.contentType,
    });
    // The `imageBytes` buffer is no longer referenced after this point; GC
    // will reclaim it on the next cycle. We never persist or log raw bytes.

    if (inference.vectors.length === 0) {
      logger.info({ photoId, eventId: row.eventId }, 'face: no faces detected');
      await writeWorkerAudit(dbClient, {
        action: 'biometric.face.indexed',
        targetKind: 'photo',
        targetId: photoId,
        eventId: row.eventId,
        payload: { faces: 0, model_version: inference.model_version },
      });
      return { status: 'indexed', faces: 0 };
    }

    // Mint stable UUIDs that double as both the face_vectors PK and the
    // Qdrant point id. This is the cross-DB join key (search.ts:64).
    const points = inference.vectors.map((face) => {
      const id = randomUUID();
      return {
        id,
        vector: face.embedding,
        payload: {
          photo_id: photoId,
          event_id: row.eventId,
          bbox: face.bbox,
          score: face.score,
          model_version: inference.model_version,
        },
        bbox: face.bbox,
        score: face.score,
      };
    });

    // Insert metadata rows first; Qdrant upsert second. On Qdrant failure the
    // metadata rows are reconciled by F1.35 retention (orphan sweep).
    await dbClient.insert(faceVectors).values(
      points.map((p) => ({
        id: p.id,
        photoId,
        eventId: row.eventId,
        bboxX: p.bbox[0],
        bboxY: p.bbox[1],
        bboxWidth: p.bbox[2],
        bboxHeight: p.bbox[3],
        // Drizzle numeric → string for safe precision.
        detectorScore: p.score.toFixed(3),
        qdrantPointId: p.id,
        modelVersion: inference.model_version,
      })),
    );

    await upsertFaceVectors(
      row.eventId,
      points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    );

    await writeWorkerAudit(dbClient, {
      action: 'biometric.face.indexed',
      targetKind: 'photo',
      targetId: photoId,
      eventId: row.eventId,
      payload: {
        faces: points.length,
        model_version: inference.model_version,
        embedding_dim: inference.embedding_dim,
      },
    });

    logger.info({ photoId, eventId: row.eventId, faces: points.length }, 'face: indexed');
    return { status: 'indexed', faces: points.length };
  } catch (error) {
    Sentry.captureException(error, { tags: { worker: 'face', photoId } });
    logger.error(
      {
        photoId,
        attempt,
        maxAttempts,
        err: error instanceof Error ? error.message : String(error),
      },
      'face: failed',
    );

    // Dead-letter on final attempt: flip the photo row to failed so the
    // dashboard can surface it. Errors here are intentionally swallowed —
    // we want BullMQ to record the original cause.
    if (attempt >= maxAttempts) {
      try {
        await dbClient
          .update(photos)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(sql`${photos.id} = ${photoId}`);
      } catch (flipError) {
        logger.error(
          {
            photoId,
            err: flipError instanceof Error ? flipError.message : String(flipError),
          },
          'face: failed to flip photo status to failed',
        );
      }
    }

    throw error;
  }
};

export const faceProcessor: Processor<FaceJobData, FaceProcessResult> = (job) =>
  processFaceJob(job);
