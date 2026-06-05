// F4.4 — OAuth authorize-URL + token exchange/refresh unit tests.

import { describe, expect, it, vi } from 'vitest';

import {
  type CloudHttpClient,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from '@pkg/integrations';

const creds = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://api.test/cb' };

describe('buildAuthorizeUrl', () => {
  it('builds a Google URL forcing offline access + re-consent', () => {
    const url = buildAuthorizeUrl('gdrive', {
      clientId: 'cid',
      redirectUri: 'https://api.test/cb',
      state: 'ST',
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('state')).toBe('ST');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('scope')).toContain('drive.readonly');
  });

  it('builds a Dropbox URL with offline token access', () => {
    const u = new URL(
      buildAuthorizeUrl('dropbox', {
        clientId: 'cid',
        redirectUri: 'https://api.test/cb',
        state: 'ST',
      }),
    );
    expect(`${u.origin}${u.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(u.searchParams.get('token_access_type')).toBe('offline');
  });
});

describe('exchangeCodeForTokens', () => {
  it('returns a token set and posts the authorization_code grant', async () => {
    const http = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer' },
    }));
    const token = await exchangeCodeForTokens('gdrive', 'code', creds, http as never, 1000);
    expect(token).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 1000 + 3600 });
    const [m, u, h, b] = http.mock.calls[0] as [string, string, Record<string, string>, unknown];
    expect(m).toBe('POST');
    expect(u).toBe('https://oauth2.googleapis.com/token');
    expect(h['content-type']).toContain('x-www-form-urlencoded');
    expect(b).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code',
      client_id: 'cid',
      redirect_uri: 'https://api.test/cb',
    });
  });

  it('throws auth when the response omits the refresh token', async () => {
    const http: CloudHttpClient = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { access_token: 'AT' },
    }));
    await expect(exchangeCodeForTokens('gdrive', 'code', creds, http)).rejects.toMatchObject({
      code: 'auth',
    });
  });

  it('maps an error status to a typed error', async () => {
    const http: CloudHttpClient = vi.fn(async () => ({ status: 400, headers: {}, body: {} }));
    await expect(exchangeCodeForTokens('gdrive', 'code', creds, http)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('refreshAccessToken', () => {
  it('merges: keeps the prior refresh token when the response omits one', async () => {
    const http: CloudHttpClient = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { access_token: 'AT2', expires_in: 3600 },
    }));
    const token = await refreshAccessToken('gdrive', 'OLD_RT', creds, http, 2000);
    expect(token).toMatchObject({ accessToken: 'AT2', refreshToken: 'OLD_RT', expiresAt: 5600 });
  });

  it('adopts a rotated refresh token when present', async () => {
    const http: CloudHttpClient = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { access_token: 'AT2', refresh_token: 'NEW_RT' },
    }));
    expect((await refreshAccessToken('dropbox', 'OLD_RT', creds, http, 0)).refreshToken).toBe(
      'NEW_RT',
    );
  });

  it('throws auth when the refresh response omits the access token', async () => {
    const http: CloudHttpClient = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    await expect(refreshAccessToken('gdrive', 'OLD_RT', creds, http)).rejects.toMatchObject({
      code: 'auth',
    });
  });
});
