// Shared ioredis connection for BullMQ. BullMQ requires
// `maxRetriesPerRequest: null` on the connection used by workers so blocking
// commands aren't aborted mid-flight.

import { Redis } from 'ioredis';

import { workerEnv } from './env.js';

let cached: Redis | undefined;

export const getRedis = (): Redis => {
  if (!cached) {
    cached = new Redis(workerEnv.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return cached;
};

export type { Redis };

// Backwards-friendly named export for callers that prefer the singleton form.
export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop) {
    const real = getRedis() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
}) as Redis;
