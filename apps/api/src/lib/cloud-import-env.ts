// F4.4 — lazy accessor for cloud-import OAuth configuration.
//
// All values are optional so the API boots without them; getCloudOAuthConfig
// returns null when a provider is not fully configured, and the connect route
// answers 503 not_configured. The state secret falls back to
// GALLERY_TOKEN_SECRET so a deploy that already signs gallery tokens gets the
// feature with no new config, while CLOUD_IMPORT_STATE_SECRET allows rotating
// it independently.

import { parseEnv, z } from '@pkg/env';
import type { CloudProvider } from '@pkg/integrations';

const schema = z.object({
  INTEGRATIONS_MASTER_KEY: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  DROPBOX_OAUTH_CLIENT_ID: z.string().optional(),
  DROPBOX_OAUTH_CLIENT_SECRET: z.string().optional(),
  CLOUD_IMPORT_STATE_SECRET: z.string().optional(),
  GALLERY_TOKEN_SECRET: z.string().optional(),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
});

type CloudImportEnv = z.infer<typeof schema>;

let cached: CloudImportEnv | undefined;
const env = (): CloudImportEnv => {
  if (!cached) cached = parseEnv(schema);
  return cached;
};

export interface CloudOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
  masterKey: string;
  appBaseUrl: string;
}

export const getCloudOAuthConfig = (provider: CloudProvider): CloudOAuthConfig | null => {
  const e = env();
  const stateSecret = e.CLOUD_IMPORT_STATE_SECRET ?? e.GALLERY_TOKEN_SECRET;
  const clientId = provider === 'gdrive' ? e.GOOGLE_OAUTH_CLIENT_ID : e.DROPBOX_OAUTH_CLIENT_ID;
  const clientSecret =
    provider === 'gdrive' ? e.GOOGLE_OAUTH_CLIENT_SECRET : e.DROPBOX_OAUTH_CLIENT_SECRET;
  if (!stateSecret || !clientId || !clientSecret || !e.INTEGRATIONS_MASTER_KEY) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${e.API_BASE_URL.replace(/\/$/, '')}/v1/integrations/${provider}/callback`,
    stateSecret,
    masterKey: e.INTEGRATIONS_MASTER_KEY,
    appBaseUrl: e.APP_BASE_URL,
  };
};
