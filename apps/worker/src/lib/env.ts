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
