// F3.12 — quality:score queue.
//
// Enqueued after derivative generation completes. Lazy-construct so this module
// imports cleanly in tests without a live Redis. Same default job options as
// the other queues (3 attempts, exponential backoff).

import { Queue } from 'bullmq';

import { getRedis } from '../lib/redis.js';
import { DEFAULT_JOB_OPTIONS } from './index.js';

export const QUALITY_QUEUE_NAME = 'quality:score' as const;

export interface QualityJobData {
  photoId: string;
}

let cached: Queue<QualityJobData> | undefined;

export const getQualityQueue = (): Queue<QualityJobData> => {
  if (!cached) {
    cached = new Queue<QualityJobData>(QUALITY_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return cached;
};

export const qualityQueue: Queue<QualityJobData> = new Proxy({} as Queue<QualityJobData>, {
  get(_target, prop) {
    const real = getQualityQueue() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
}) as Queue<QualityJobData>;
