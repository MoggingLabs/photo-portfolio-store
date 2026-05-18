import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { IngestJobData } from '../src/queues/index.js';
import { processIngest } from '../src/workers/ingest.js';

interface StubRow {
  id: string;
  eventId: string;
  status: 'processing' | 'ready' | 'failed';
}

const buildDb = (row: StubRow | undefined) => {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  return { select, insert, insertValues } as const;
};

const buildJob = (photoId: string): Job<IngestJobData> =>
  ({ data: { photoId }, opts: { attempts: 3 }, attemptsMade: 0 }) as unknown as Job<IngestJobData>;

describe('processIngest', () => {
  it('fans out derivatives + watermark + face when photo is processing', async () => {
    const db = buildDb({ id: 'p1', eventId: 'e1', status: 'processing' });
    const derivativesQueue = { add: vi.fn().mockResolvedValue({}) };
    const watermarkQueue = { add: vi.fn().mockResolvedValue({}) };
    const faceQueue = { add: vi.fn().mockResolvedValue({}) };

    const result = await processIngest(buildJob('p1'), {
      db: db as never,
      derivativesQueue: derivativesQueue as never,
      watermarkQueue: watermarkQueue as never,
      faceQueue: faceQueue as never,
    });

    expect(result.status).toBe('fanned-out');
    expect(derivativesQueue.add).toHaveBeenCalledTimes(1);
    expect(derivativesQueue.add).toHaveBeenCalledWith(
      'derivatives',
      { photoId: 'p1' },
      expect.objectContaining({ jobId: 'derivatives:p1' }),
    );
    expect(watermarkQueue.add).toHaveBeenCalledTimes(1);
    expect(watermarkQueue.add).toHaveBeenCalledWith(
      'watermark',
      { photoId: 'p1' },
      expect.objectContaining({ jobId: 'watermark:p1' }),
    );
    expect(faceQueue.add).toHaveBeenCalledTimes(1);
    expect(faceQueue.add).toHaveBeenCalledWith(
      'face',
      { photoId: 'p1' },
      expect.objectContaining({ jobId: 'face:p1' }),
    );
    // audit insert
    expect(db.insertValues).toHaveBeenCalled();
  });

  it('skips when photo is not found', async () => {
    const db = buildDb(undefined);
    const derivativesQueue = { add: vi.fn() };
    const watermarkQueue = { add: vi.fn() };
    const faceQueue = { add: vi.fn() };
    const result = await processIngest(buildJob('missing'), {
      db: db as never,
      derivativesQueue: derivativesQueue as never,
      watermarkQueue: watermarkQueue as never,
      faceQueue: faceQueue as never,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(derivativesQueue.add).not.toHaveBeenCalled();
    expect(watermarkQueue.add).not.toHaveBeenCalled();
    expect(faceQueue.add).not.toHaveBeenCalled();
  });

  it('skips when photo is not in processing status', async () => {
    const db = buildDb({ id: 'p1', eventId: 'e1', status: 'ready' });
    const derivativesQueue = { add: vi.fn() };
    const watermarkQueue = { add: vi.fn() };
    const faceQueue = { add: vi.fn() };
    const result = await processIngest(buildJob('p1'), {
      db: db as never,
      derivativesQueue: derivativesQueue as never,
      watermarkQueue: watermarkQueue as never,
      faceQueue: faceQueue as never,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('ready');
    expect(derivativesQueue.add).not.toHaveBeenCalled();
    expect(faceQueue.add).not.toHaveBeenCalled();
  });
});
