// Minimal DB client wrapper shared across route plugins.
//
// Other agents may also create this file; keep it minimal and additive so
// merges are trivial.
//
// The client is constructed lazily on first access so importing this module
// does not crash test environments where DATABASE_URL is intentionally
// absent (RBAC tests, for example, inject a stub db).

import { type DbClient, createDbClient } from '@pkg/db';
import { parseEnv, z } from '@pkg/env';

let cached: DbClient | undefined;

const dbEnvSchema = z.object({ DATABASE_URL: z.string().min(1) });

const getDb = (): DbClient => {
  if (cached) return cached;
  const env = parseEnv(dbEnvSchema);
  cached = createDbClient(env.DATABASE_URL);
  return cached;
};

// Proxy keeps the `db.select(...)` / `db.insert(...)` ergonomics while
// deferring construction until the first method call.
export const db = new Proxy({} as DbClient, {
  get(_target, prop, _receiver) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
}) as DbClient;
