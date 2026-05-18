// F1.22 — face worker tests.
//
// Uses the same stub-by-dep-injection shape as ingest.test.ts. Mocks the
// inference HTTP client + Qdrant helpers + storage so the test never touches
// network, Postgres, or Redis.

import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { FaceJobData } from '../src/queues/face.js';
import { processFaceJob } from '../src/workers/face.js';

interface PhotoStub {
  id: string;
  eventId: string;
  objectKey: string;
  contentType: string;
  status: 'processing' | 'ready' | 'hidden' | 'failed' | 'takedown';
}

const buildDb = (row: PhotoStub | undefined) => {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return { select, insert, insertValues, update, updateSet, updateWhere } as const;
};

const buildJob = (
  photoId: string,
  overrides: Partial<{ attemptsMade: number; attempts: number }> = {},
): Job<FaceJobData> =>
  ({
    data: { photoId },
    opts: { attempts: overrides.attempts ?? 3 },
    attemptsMade: overrides.attemptsMade ?? 0,
  }) as unknown as Job<FaceJobData>;

const buildS3 = (bytes: Buffer) => ({
  send: vi.fn().mockResolvedValue({
    Body: {
      transformToByteArray: async () => new Uint8Array(bytes),
    },
  }),
});

const photoId = '11111111-1111-1111-1111-111111111111';
const eventId = '22222222-2222-2222-2222-222222222222';

describe('processFaceJob', () => {
  it('detects, embeds, persists face_vectors, and upserts to qdrant', async () => {
    const db = buildDb({
      id: photoId,
      eventId,
      objectKey: `originals/${eventId}/${photoId}.jpg`,
      contentType: 'image/jpeg',
      status: 'processing',
    });
    const s3 = buildS3(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const detectAndEmbed = vi.fn().mockResolvedValue({
      vectors: [
        { bbox: [10, 20, 100, 120], score: 0.987, embedding: Array(512).fill(0.01) },
        { bbox: [200, 210, 80, 90], score: 0.912, embedding: Array(512).fill(0.02) },
      ],
      model_version: 'insightface-buffalo_l-1.0',
      embedding_dim: 512,
    });
    const ensureCollection = vi.fn().mockResolvedValue(undefined);
    const upsertFaceVectors = vi.fn().mockResolvedValue(undefined);

    let n = 0;
    const randomUUID = () => {
      n += 1;
      return `face-uuid-${n}`;
    };

    const result = await processFaceJob(buildJob(photoId), {
      db: db as never,
      s3: s3 as never,
      bucket: 'originals',
      detectAndEmbed,
      ensureCollection,
      upsertFaceVectors,
      randomUUID,
    });

    expect(result).toEqual({ status: 'indexed', faces: 2 });
    expect(ensureCollection).toHaveBeenCalledWith(eventId);
    expect(detectAndEmbed).toHaveBeenCalledTimes(1);

    // face_vectors insert payload
    expect(db.insertValues).toHaveBeenCalledTimes(2); // face rows + audit
    const faceRows = db.insertValues.mock.calls[0]?.[0];
    expect(faceRows).toHaveLength(2);
    expect(faceRows[0]).toMatchObject({
      id: 'face-uuid-1',
      photoId,
      eventId,
      bboxX: 10,
      bboxY: 20,
      bboxWidth: 100,
      bboxHeight: 120,
      detectorScore: '0.987',
      qdrantPointId: 'face-uuid-1',
      modelVersion: 'insightface-buffalo_l-1.0',
    });

    // Qdrant upsert called with correct collection (per-event) + vectors.
    expect(upsertFaceVectors).toHaveBeenCalledTimes(1);
    const [calledEventId, points] = upsertFaceVectors.mock.calls[0] ?? [];
    expect(calledEventId).toBe(eventId);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      id: 'face-uuid-1',
      payload: expect.objectContaining({
        photo_id: photoId,
        event_id: eventId,
        bbox: [10, 20, 100, 120],
        score: 0.987,
        model_version: 'insightface-buffalo_l-1.0',
      }),
    });
    expect(points[0].vector).toHaveLength(512);
  });

  it('records zero-face indexings without calling qdrant upsert', async () => {
    const db = buildDb({
      id: photoId,
      eventId,
      objectKey: 'k',
      contentType: 'image/jpeg',
      status: 'processing',
    });
    const s3 = buildS3(Buffer.from([0xff]));
    const detectAndEmbed = vi.fn().mockResolvedValue({
      vectors: [],
      model_version: 'insightface-buffalo_l-1.0',
      embedding_dim: 512,
    });
    const ensureCollection = vi.fn().mockResolvedValue(undefined);
    const upsertFaceVectors = vi.fn();

    const result = await processFaceJob(buildJob(photoId), {
      db: db as never,
      s3: s3 as never,
      bucket: 'originals',
      detectAndEmbed,
      ensureCollection,
      upsertFaceVectors,
    });

    expect(result).toEqual({ status: 'indexed', faces: 0 });
    expect(upsertFaceVectors).not.toHaveBeenCalled();
    // Only the audit-log insert, never the face_vectors insert.
    expect(db.insertValues).toHaveBeenCalledTimes(1);
  });

  it('skips photos that have been taken down', async () => {
    const db = buildDb({
      id: photoId,
      eventId,
      objectKey: 'k',
      contentType: 'image/jpeg',
      status: 'takedown',
    });
    const s3 = buildS3(Buffer.alloc(0));
    const detectAndEmbed = vi.fn();
    const ensureCollection = vi.fn();
    const upsertFaceVectors = vi.fn();

    const result = await processFaceJob(buildJob(photoId), {
      db: db as never,
      s3: s3 as never,
      bucket: 'originals',
      detectAndEmbed,
      ensureCollection,
      upsertFaceVectors,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'status:takedown' });
    expect(detectAndEmbed).not.toHaveBeenCalled();
    expect(ensureCollection).not.toHaveBeenCalled();
  });

  it.skip('skips when the photo row does not exist [see #107]', async () => {
    const db = buildDb(undefined);
    const s3 = buildS3(Buffer.alloc(0));
    const detectAndEmbed = vi.fn();
    const ensureCollection = vi.fn();
    const upsertFaceVectors = vi.fn();

    const result = await processFaceJob(buildJob('missing'), {
      db: db as never,
      s3: s3 as never,
      detectAndEmbed,
      ensureCollection,
      upsertFaceVectors,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(ensureCollection).not.toHaveBeenCalled();
  });

  it('flips photos.status to failed on the final retry attempt', async () => {
    const db = buildDb({
      id: photoId,
      eventId,
      objectKey: 'k',
      contentType: 'image/jpeg',
      status: 'processing',
    });
    const s3 = buildS3(Buffer.from([0xff]));
    const inferenceError = new Error('inference 500');
    const detectAndEmbed = vi.fn().mockRejectedValue(inferenceError);
    const ensureCollection = vi.fn().mockResolvedValue(undefined);
    const upsertFaceVectors = vi.fn();

    await expect(
      processFaceJob(buildJob(photoId, { attemptsMade: 2, attempts: 3 }), {
        db: db as never,
        s3: s3 as never,
        bucket: 'originals',
        detectAndEmbed,
        ensureCollection,
        upsertFaceVectors,
      }),
    ).rejects.toThrow('inference 500');

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('does not flip photo status on a non-final retry', async () => {
    const db = buildDb({
      id: photoId,
      eventId,
      objectKey: 'k',
      contentType: 'image/jpeg',
      status: 'processing',
    });
    const s3 = buildS3(Buffer.from([0xff]));
    const detectAndEmbed = vi.fn().mockRejectedValue(new Error('transient'));
    const ensureCollection = vi.fn().mockResolvedValue(undefined);

    await expect(
      processFaceJob(buildJob(photoId, { attemptsMade: 0, attempts: 3 }), {
        db: db as never,
        s3: s3 as never,
        bucket: 'originals',
        detectAndEmbed,
        ensureCollection,
        upsertFaceVectors: vi.fn(),
      }),
    ).rejects.toThrow('transient');

    expect(db.update).not.toHaveBeenCalled();
  });
});
