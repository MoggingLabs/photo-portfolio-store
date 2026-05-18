// F1.22 — face:detect-embed queue.
//
// Lazy-construct so this module can be imported in tests without a live Redis.
// Shape mirrors the other queues in ../queues/index.ts and uses the same
// default job options (3 attempts, exponential backoff).

import { Queue } from 'bullmq';

import { getRedis } from '../lib/redis.js';
import { DEFAULT_JOB_OPTIONS } from './index.js';

export const FACE_QUEUE_NAME = 'face:detect-embed' as const;

export interface FaceJobData {
  photoId: string;
}

let cached: Queue<FaceJobData> | undefined;

export const getFaceQueue = (): Queue<FaceJobData> => {
  if (!cached) {
    cached = new Queue<FaceJobData>(FACE_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return cached;
};

// Proxy convenience: lets callers `import { faceQueue }` without invoking
// queue construction at import time.
export const faceQueue: Queue<FaceJobData> = new Proxy({} as Queue<FaceJobData>, {
  get(_target, prop) {
    const real = getFaceQueue() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
}) as Queue<FaceJobData>;
