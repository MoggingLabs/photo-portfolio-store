// S3 / R2 client used by the upload service.
//
// The API never proxies bytes — chunks are uploaded by the client directly
// to R2 / S3 via presigned URLs returned from `presignChunk`.

import { S3Client } from '@aws-sdk/client-s3';
import { parseEnv, z } from '@pkg/env';

const storageEnvSchema = z.object({
  // Empty for AWS, set for R2 / MinIO / other S3-compatible storage.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_ORIGINALS: z.string().min(1),
  S3_BUCKET_DERIVATIVES: z.string().min(1),
  S3_PUBLIC_BASE_URL: z.string().url(),
});

const storageEnv = parseEnv(storageEnvSchema);

export const s3: S3Client = new S3Client({
  region: storageEnv.S3_REGION,
  ...(storageEnv.S3_ENDPOINT ? { endpoint: storageEnv.S3_ENDPOINT, forcePathStyle: true } : {}),
  credentials: {
    accessKeyId: storageEnv.S3_ACCESS_KEY_ID,
    secretAccessKey: storageEnv.S3_SECRET_ACCESS_KEY,
  },
});

export const buckets = {
  originals: storageEnv.S3_BUCKET_ORIGINALS,
  derivatives: storageEnv.S3_BUCKET_DERIVATIVES,
} as const;

export const publicBaseUrl: string = storageEnv.S3_PUBLIC_BASE_URL;
