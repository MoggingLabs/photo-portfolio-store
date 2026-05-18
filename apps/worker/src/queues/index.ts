// Queue registry. Lazy-construct queues so importing this module in tests
// doesn't require a live Redis. The retry policy lives next to the queue
// constructor so producers and consumers see the same defaults.

import { type JobsOptions, Queue } from 'bullmq';

import { getRedis } from '../lib/redis.js';

export const QUEUE_NAMES = {
  ingestFanOut: 'ingest:fan-out',
  derivatives: 'derivatives',
  watermark: 'watermark',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// 3 attempts, exponential backoff starting at 1s. Dead letters land on the
// failed set by default (BullMQ semantics); a sweeper job can move them later.
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000 },
};

export interface IngestJobData {
  photoId: string;
}

export interface DerivativesJobData {
  photoId: string;
}

export interface WatermarkJobData {
  photoId: string;
}

let _ingest: Queue<IngestJobData> | undefined;
let _derivatives: Queue<DerivativesJobData> | undefined;
let _watermark: Queue<WatermarkJobData> | undefined;

export const getIngestQueue = (): Queue<IngestJobData> => {
  if (!_ingest) {
    _ingest = new Queue<IngestJobData>(QUEUE_NAMES.ingestFanOut, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _ingest;
};

export const getDerivativesQueue = (): Queue<DerivativesJobData> => {
  if (!_derivatives) {
    _derivatives = new Queue<DerivativesJobData>(QUEUE_NAMES.derivatives, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _derivatives;
};

export const getWatermarkQueue = (): Queue<WatermarkJobData> => {
  if (!_watermark) {
    _watermark = new Queue<WatermarkJobData>(QUEUE_NAMES.watermark, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _watermark;
};
