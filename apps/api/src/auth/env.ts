import { parseEnv, z } from '@pkg/env';

export const authEnv = parseEnv(
  z.object({
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
    ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
    RATE_LIMIT_AUTH_REQS_PER_MIN: z.coerce.number().int().positive().default(10),
  }),
);

export type AuthEnv = typeof authEnv;
