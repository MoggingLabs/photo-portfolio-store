import { Buffer } from 'node:buffer';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { WatermarkJobData } from '../src/queues/index.js';
import { processWatermark } from '../src/workers/watermark.js';

interface SelectScenario {
  photo?: { id: string; eventId: string };
  settings?: { watermarkText: string | null; watermarkOpacity: string };
  preview?: { objectKey: string };
}

const buildDb = (scenario: SelectScenario) => {
  const responses: unknown[][] = [
    scenario.photo ? [scenario.photo] : [],
    scenario.settings ? [scenario.settings] : [],
    scenario.preview ? [scenario.preview] : [],
  ];
  let callIndex = 0;
  const select = vi.fn(() => {
    const result = responses[callIndex] ?? [];
    callIndex += 1;
    const limit = vi.fn().mockResolvedValue(result);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });

  // insert -> values() resolves to undefined (audit insert).
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  // update -> set -> where resolves.
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  return { select, insert, insertValues, update, updateSet } as const;
};

const buildS3 = () => {
  const send = vi.fn().mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetObjectCommand') {
      return { Body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
    }
    return {};
  });
  return { send } as const;
};

const makeSharpStub = () => {
  const pipeline: Record<string, unknown> = {};
  for (const fn of ['rotate', 'resize', 'jpeg', 'withMetadata', 'composite']) {
    pipeline[fn] = vi.fn().mockReturnValue(pipeline);
  }
  const compositeSpy = vi.fn().mockReturnValue(pipeline);
  pipeline.composite = compositeSpy;
  pipeline.metadata = vi.fn().mockResolvedValue({ width: 1600, height: 1200 });
  pipeline.toBuffer = vi.fn().mockResolvedValue({
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    info: { size: 2222, width: 1600, height: 1200 },
  });
  const factory = vi.fn(() => pipeline) as unknown as typeof import('sharp').default;
  return { factory, compositeSpy };
};

const buildJob = (): Job<WatermarkJobData> =>
  ({
    data: { photoId: 'p1' },
    opts: { attempts: 3 },
    attemptsMade: 0,
  }) as unknown as Job<WatermarkJobData>;

describe('processWatermark', () => {
  it('composites watermark onto preview when text is configured', async () => {
    const db = buildDb({
      photo: { id: 'p1', eventId: 'e1' },
      settings: { watermarkText: 'EVENT 2026', watermarkOpacity: '0.40' },
      preview: { objectKey: 'derivatives/e1/p1/preview.jpg' },
    });
    const s3 = buildS3();
    const { factory, compositeSpy } = makeSharpStub();

    const result = await processWatermark(buildJob(), {
      db: db as never,
      s3: s3 as never,
      buckets: { derivatives: 'deriv' },
      sharpFactory: factory,
    });

    expect(result).toEqual({ status: 'applied' });
    expect(compositeSpy).toHaveBeenCalledTimes(1);
    // The composite input must be a Buffer (SVG bytes).
    const overlayArg = compositeSpy.mock.calls[0]?.[0] as Array<{ input: unknown }>;
    expect(Buffer.isBuffer(overlayArg[0].input)).toBe(true);
    // 1 GET + 1 PUT.
    expect(s3.send).toHaveBeenCalledTimes(2);
    // photoDerivatives update + audit insert.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ watermarked: true, bytes: 2222 }),
    );
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('skips when watermark text is empty (no-op path)', async () => {
    const db = buildDb({
      photo: { id: 'p1', eventId: 'e1' },
      settings: { watermarkText: '', watermarkOpacity: '0.40' },
    });
    const s3 = buildS3();
    const { factory, compositeSpy } = makeSharpStub();

    const result = await processWatermark(buildJob(), {
      db: db as never,
      s3: s3 as never,
      buckets: { derivatives: 'deriv' },
      sharpFactory: factory,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'no_watermark_text' });
    expect(compositeSpy).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
    // audit log for skipped path.
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('skips when preview derivative is missing', async () => {
    const db = buildDb({
      photo: { id: 'p1', eventId: 'e1' },
      settings: { watermarkText: 'EVENT', watermarkOpacity: '0.40' },
    });
    const s3 = buildS3();
    const { factory, compositeSpy } = makeSharpStub();

    const result = await processWatermark(buildJob(), {
      db: db as never,
      s3: s3 as never,
      buckets: { derivatives: 'deriv' },
      sharpFactory: factory,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'preview_missing' });
    expect(compositeSpy).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });
});
