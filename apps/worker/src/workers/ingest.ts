// F1.12 — ingest fan-out worker.
//
// Triggered after an upload session completes and the photos row has been
// flipped to status='processing'. Validates the row, then fans out to the
// derivatives + watermark queues. Face/bib detection queues are owned by
// parallel agents (F1.22 / F1.19); we leave a TODO hook here so the import
// can be added once those queues land.

import { type DbClient, schema } from '@pkg/db';
import * as Sentry from '@sentry/node';
import type { Job, Processor, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';

import { writeWorkerAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { type FaceJobData, getFaceQueue } from '../queues/face.js';
import {
  DEFAULT_JOB_OPTIONS,
  type DerivativesJobData,
  type IngestJobData,
  type WatermarkJobData,
  getDerivativesQueue,
  getWatermarkQueue,
} from '../queues/index.js';

const { photos } = schema.photos;

export interface IngestDeps {
  db?: DbClient;
  derivativesQueue?: Queue<DerivativesJobData>;
  watermarkQueue?: Queue<WatermarkJobData>;
  faceQueue?: Queue<FaceJobData>;
}

export interface IngestResult {
  status: 'fanned-out' | 'skipped';
  reason?: string;
}

/**
 * Looks up the photo and, if it is in `processing`, enqueues derivative +
 * watermark jobs. Pure function shape so the unit test can pass stubs in.
 */
export const processIngest = async (
  job: Job<IngestJobData>,
  deps: IngestDeps = {},
): Promise<IngestResult> => {
  const dbClient = deps.db ?? defaultDb;
  const derivativesQueue = deps.derivativesQueue ?? getDerivativesQueue();
  const watermarkQueue = deps.watermarkQueue ?? getWatermarkQueue();
  const faceQueue = deps.faceQueue ?? getFaceQueue();
  const { photoId } = job.data;

  try {
    const rows = await dbClient
      .select({
        id: photos.id,
        eventId: photos.eventId,
        status: photos.status,
      })
      .from(photos)
      .where(sql`${photos.id} = ${photoId}`)
      .limit(1);

    const row = rows[0];
    if (!row) {
      logger.warn({ photoId }, 'ingest: photo not found, skipping');
      return { status: 'skipped', reason: 'not_found' };
    }
    if (row.status !== 'processing') {
      logger.warn({ photoId, status: row.status }, 'ingest: photo not in processing, skipping');
      return { status: 'skipped', reason: `status:${row.status}` };
    }

    // Stable job ids prevent duplicate fan-out on retries.
    await derivativesQueue.add(
      'derivatives',
      { photoId },
      { ...DEFAULT_JOB_OPTIONS, jobId: `derivatives:${photoId}` },
    );
    await watermarkQueue.add(
      'watermark',
      { photoId },
      { ...DEFAULT_JOB_OPTIONS, jobId: `watermark:${photoId}` },
    );
    // F1.22 — face detection + embedding. Same stable-job-id pattern.
    await faceQueue.add('face', { photoId }, { ...DEFAULT_JOB_OPTIONS, jobId: `face:${photoId}` });

    // TODO(F1.19): enqueue bib:ocr once that queue lands.

    await writeWorkerAudit(dbClient, {
      action: 'media.ingest.fan_out',
      targetKind: 'photo',
      targetId: photoId,
      eventId: row.eventId,
      payload: { queues: ['derivatives', 'watermark', 'face'] },
    });

    logger.info({ photoId, eventId: row.eventId }, 'ingest: fan-out complete');
    return { status: 'fanned-out' };
  } catch (error) {
    Sentry.captureException(error, { tags: { worker: 'ingest', photoId } });
    logger.error(
      { photoId, err: error instanceof Error ? error.message : String(error) },
      'ingest: failed',
    );
    throw error;
  }
};

export const ingestProcessor: Processor<IngestJobData, IngestResult> = (job) => processIngest(job);
