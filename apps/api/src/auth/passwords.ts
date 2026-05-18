import argon2 from 'argon2';
import { authEnv } from './env.js';

/**
 * Hashes a plaintext password using argon2id with project-tuned parameters.
 * memoryCost is configurable via ARGON2_MEMORY_KIB to allow tuning across
 * deployment environments (CI vs production hardware).
 */
export const hashPassword = async (plain: string): Promise<string> => {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: authEnv.ARGON2_MEMORY_KIB,
    timeCost: 2,
    parallelism: 1,
  });
};

/**
 * Verifies a plaintext password against a stored hash. Returns false on any
 * error rather than throwing so callers can use it in constant-time flows
 * without leaking timing information about hash format issues.
 */
export const verifyPassword = async (plain: string, hash: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};
