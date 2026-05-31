// Worker-local env validation. Mirrors the apps/api pattern but adds the
// Redis URL needed by BullMQ and skips the API-only PUBLIC_BASE_URL.

import { parseEnv, z } from '@pkg/env';

export const workerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_ORIGINALS: z.string().min(1),
  S3_BUCKET_DERIVATIVES: z.string().min(1),
  // F3.12 — quality thresholds. Env-configurable, never hardcoded in business
  // logic. blur_score below the threshold flags blur; phash Hamming distance at
  // or below the max within an event flags a near-duplicate.
  QUALITY_BLUR_THRESHOLD: z.coerce.number().positive().default(100),
  QUALITY_PHASH_HAMMING_MAX: z.coerce.number().int().nonnegative().default(6),
  // F4.11 — master key for decrypting outbound-webhook HMAC secrets. Optional
  // here so the worker boots without it; the delivery job throws clearly if a
  // delivery is attempted while unset.
  INTEGRATIONS_MASTER_KEY: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

let cached: WorkerEnv | undefined;

// Lazy parse so importing this module in a test environment without all the
// required env vars doesn't crash. Tests stub the consumers directly.
export const workerEnv: WorkerEnv = new Proxy({} as WorkerEnv, {
  get(_target, prop) {
    if (!cached) cached = parseEnv(workerEnvSchema);
    return cached[prop as keyof WorkerEnv];
  },
});
