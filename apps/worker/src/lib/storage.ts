// S3 / R2 client for the worker. Mirrors apps/api/src/lib/storage.ts.
// Workers GET originals and PUT derivatives — they never proxy bytes for the
// browser, so no presigner is initialized here.

import { S3Client } from '@aws-sdk/client-s3';

import { workerEnv } from './env.js';

let cachedClient: S3Client | undefined;

const buildClient = (): S3Client =>
  new S3Client({
    region: workerEnv.S3_REGION,
    ...(workerEnv.S3_ENDPOINT ? { endpoint: workerEnv.S3_ENDPOINT, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: workerEnv.S3_ACCESS_KEY_ID,
      secretAccessKey: workerEnv.S3_SECRET_ACCESS_KEY,
    },
  });

export const getS3 = (): S3Client => {
  if (!cachedClient) cachedClient = buildClient();
  return cachedClient;
};

export const buckets = {
  get originals(): string {
    return workerEnv.S3_BUCKET_ORIGINALS;
  },
  get derivatives(): string {
    return workerEnv.S3_BUCKET_DERIVATIVES;
  },
} as const;
