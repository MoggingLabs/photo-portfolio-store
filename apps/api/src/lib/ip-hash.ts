// F1.33 — salted SHA-256 of an IP address for biometric consent soft-binding.
//
// Distinct from lib/audit.ts#hashIp (which is unsalted): consent bindings
// must not be reversible across services, so we add a project-wide secret
// salt. Compromise of the audit hash should not expose a consent binding to
// rainbow-table lookup.

import { createHash } from 'node:crypto';

const SALT_ENV_KEY = 'IP_HASH_SALT';
// Dev-only default keeps tests + local dev working without setup. Production
// startup is expected to set IP_HASH_SALT to a high-entropy value.
const DEV_DEFAULT_SALT = 'dev-only-ip-hash-salt-change-in-prod';

const getSalt = (): string => {
  const raw = process.env[SALT_ENV_KEY];
  if (raw && raw.length > 0) return raw;
  return DEV_DEFAULT_SALT;
};

export const hashIp = (ip: string | null | undefined): string | undefined => {
  if (!ip) return undefined;
  const salt = getSalt();
  return createHash('sha256').update(`${salt}::${ip}`, 'utf8').digest('hex');
};
