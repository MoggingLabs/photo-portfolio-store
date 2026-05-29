// F4.1 — lazy accessor for the connector-credential master key.
//
// Read from INTEGRATIONS_MASTER_KEY (base64-encoded 32 bytes). Parsed lazily so
// importing modules in a test/boot context without the key set does not crash;
// the error surfaces only when an integrations route actually needs to
// encrypt/decrypt. Generate with: openssl rand -base64 32

import { parseEnv, z } from '@pkg/env';

let cached: string | undefined;

export const getIntegrationsMasterKey = (): string => {
  if (cached) return cached;
  const { INTEGRATIONS_MASTER_KEY } = parseEnv(
    z.object({ INTEGRATIONS_MASTER_KEY: z.string().min(1) }),
  );
  cached = INTEGRATIONS_MASTER_KEY;
  return cached;
};
