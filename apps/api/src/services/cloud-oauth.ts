// F4.4 — cloud-import OAuth: authorize-URL building + callback completion.
//
// The connection (access + refresh token) is stored per-org in
// integration_configs (type 'gdrive'/'dropbox'), envelope-encrypted via the F4.1
// crypto, with enabled=true so the worker sweep picks it up. The callback is
// public (no bearer), so the initiating org/user travel in the HMAC-signed state
// rather than the session — verified here before any token is written.

import { type DbClient, schema } from '@pkg/db';
import {
  type CloudHttpClient,
  type CloudProvider,
  buildAuthorizeUrl,
  encryptCredentials,
  exchangeCodeForTokens,
  signOAuthState,
  verifyOAuthState,
} from '@pkg/integrations';

const { integrationConfigs } = schema.integrations;

export class CloudOAuthError extends Error {
  constructor(
    public readonly code: 'invalid_state' | 'provider_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'CloudOAuthError';
  }
}

export interface ConnectConfig {
  clientId: string;
  redirectUri: string;
  stateSecret: string;
}

const nowSec = (now?: () => Date): number | undefined =>
  now ? Math.floor(now().getTime() / 1000) : undefined;

export const buildConnectUrl = (
  orgId: string,
  userId: string,
  provider: CloudProvider,
  cfg: ConnectConfig,
  now?: () => Date,
): string => {
  const ns = nowSec(now);
  const state = signOAuthState(
    orgId,
    userId,
    provider,
    cfg.stateSecret,
    ns !== undefined ? { nowSec: ns } : {},
  );
  return buildAuthorizeUrl(provider, {
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    state,
  });
};

export interface CallbackConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
  masterKey: string;
}

export const completeConnection = async (
  db: DbClient,
  provider: CloudProvider,
  code: string,
  state: string,
  cfg: CallbackConfig,
  http: CloudHttpClient,
  now?: () => Date,
): Promise<{ orgId: string }> => {
  const claims = verifyOAuthState(state, cfg.stateSecret, nowSec(now));
  if (!claims) throw new CloudOAuthError('invalid_state', 'invalid or expired state');
  if (claims.provider !== provider) {
    throw new CloudOAuthError('provider_mismatch', 'state provider does not match callback');
  }
  const tokenSet = await exchangeCodeForTokens(
    provider,
    code,
    { clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri },
    http,
    nowSec(now),
  );
  const at = now ? now() : new Date();
  const encrypted = encryptCredentials(JSON.stringify(tokenSet), cfg.masterKey);
  const configJson = { scopes: tokenSet.scope ?? null };
  await db
    .insert(integrationConfigs)
    .values({
      orgId: claims.orgId,
      type: provider,
      enabled: true,
      encryptedCredentials: encrypted,
      configJson,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [integrationConfigs.orgId, integrationConfigs.type],
      set: {
        enabled: true,
        encryptedCredentials: encrypted,
        configJson,
        lastError: null,
        updatedAt: at,
      },
    });
  return { orgId: claims.orgId };
};
