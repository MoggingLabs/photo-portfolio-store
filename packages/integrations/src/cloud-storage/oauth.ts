// F4.4 — OAuth authorize-URL builder + token exchange/refresh for the cloud
// providers. Pure functions over an injected HTTP client (live token endpoints
// are not reachable in this environment, so these are fixture-tested).
//
// Refresh contract: Google returns a refresh_token only on the FIRST consent and
// omits it from subsequent refresh responses; Dropbox refresh tokens are
// long-lived and likewise absent from refresh responses. refreshAccessToken
// therefore MERGES — it keeps the previously stored refresh token when the
// response omits one. The authorize URL forces offline access + re-consent so a
// reconnect always re-issues a refresh token.

import { cloudErrorForStatus } from './retry.js';
import {
  type CloudHttpClient,
  type CloudProvider,
  CloudStorageError,
  type CloudTokenSet,
  type OAuthClientCredentials,
} from './types.js';

interface ProviderOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  // Extra authorize-URL params that force a refresh-token to be issued.
  authParams: Record<string, string>;
}

const PROVIDER_OAUTH: Record<CloudProvider, ProviderOAuthConfig> = {
  gdrive: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  dropbox: {
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scope: 'files.metadata.read files.content.read',
    authParams: { token_access_type: 'offline' },
  },
};

export interface BuildAuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  // The signed OAuth state (see oauth-state.ts).
  state: string;
}

export const buildAuthorizeUrl = (
  provider: CloudProvider,
  params: BuildAuthorizeUrlParams,
): string => {
  const cfg = PROVIDER_OAUTH[provider];
  const qs = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: cfg.scope,
    state: params.state,
    ...cfg.authParams,
  });
  return `${cfg.authUrl}?${qs.toString()}`;
};

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const formHeaders = (): Record<string, string> => ({
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'application/json',
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const exchangeCodeForTokens = async (
  provider: CloudProvider,
  code: string,
  creds: OAuthClientCredentials,
  http: CloudHttpClient,
  nowSec: number = nowSeconds(),
): Promise<CloudTokenSet> => {
  const cfg = PROVIDER_OAUTH[provider];
  const res = await http('POST', cfg.tokenUrl, formHeaders(), {
    grant_type: 'authorization_code',
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
  });
  if (res.status !== 200) {
    throw cloudErrorForStatus(
      res.status,
      `${provider} token exchange ${res.status}`,
      res.headers,
      res.body,
    );
  }
  const body = (res.body ?? {}) as TokenResponseBody;
  if (!body.access_token) {
    throw new CloudStorageError('auth', `${provider} token response missing access_token`);
  }
  if (!body.refresh_token) {
    // Without a refresh token the worker cannot keep the connection alive.
    throw new CloudStorageError('auth', `${provider} token response missing refresh_token`);
  }
  const token: CloudTokenSet = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: nowSec + (body.expires_in ?? 3600),
  };
  if (body.scope) token.scope = body.scope;
  if (body.token_type) token.tokenType = body.token_type;
  return token;
};

export const refreshAccessToken = async (
  provider: CloudProvider,
  refreshToken: string,
  creds: OAuthClientCredentials,
  http: CloudHttpClient,
  nowSec: number = nowSeconds(),
): Promise<CloudTokenSet> => {
  const cfg = PROVIDER_OAUTH[provider];
  const res = await http('POST', cfg.tokenUrl, formHeaders(), {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  if (res.status !== 200) {
    throw cloudErrorForStatus(
      res.status,
      `${provider} token refresh ${res.status}`,
      res.headers,
      res.body,
    );
  }
  const body = (res.body ?? {}) as TokenResponseBody;
  if (!body.access_token) {
    throw new CloudStorageError('auth', `${provider} refresh response missing access_token`);
  }
  const token: CloudTokenSet = {
    accessToken: body.access_token,
    // MERGE: keep the prior refresh token when the response omits one.
    refreshToken: body.refresh_token ?? refreshToken,
    expiresAt: nowSec + (body.expires_in ?? 3600),
  };
  if (body.scope) token.scope = body.scope;
  if (body.token_type) token.tokenType = body.token_type;
  return token;
};
