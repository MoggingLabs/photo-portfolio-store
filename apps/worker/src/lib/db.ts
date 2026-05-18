// Lazy worker DB client. Mirrors apps/api/src/lib/db.ts so workers and API
// share the same construction pattern.

import { type DbClient, createDbClient } from '@pkg/db';

import { workerEnv } from './env.js';

let cached: DbClient | undefined;

const getDb = (): DbClient => {
  if (cached) return cached;
  cached = createDbClient(workerEnv.DATABASE_URL);
  return cached;
};

export const db = new Proxy({} as DbClient, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
}) as DbClient;
