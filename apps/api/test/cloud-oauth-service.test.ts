// F4.4 — cloud-oauth service tests (real crypto + state, stub token exchange).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const col = (column: string) => ({ column });
const cols = (...names: string[]) => Object.fromEntries(names.map((n) => [n, col(n)]));

vi.mock('@pkg/db', () => ({
  schema: {
    integrations: {
      integrationConfigs: cols(
        'orgId',
        'type',
        'enabled',
        'encryptedCredentials',
        'configJson',
        'lastError',
        'updatedAt',
      ),
    },
  },
}));

import {
  type CloudHttpClient,
  decryptCredentials,
  signOAuthState,
  verifyOAuthState,
} from '@pkg/integrations';

type Row = Record<string, unknown>;
let configs: Row[];

const makeDb = () => ({
  insert: () => ({
    values: (v: Row) => ({
      onConflictDoUpdate: ({ set }: { set: Row }) => {
        const existing = configs.find((r) => r.orgId === v.orgId && r.type === v.type);
        if (existing) Object.assign(existing, set);
        else configs.push({ ...v });
        return Promise.resolve();
      },
    }),
  }),
});

const MASTER_KEY = Buffer.alloc(32, 1).toString('base64');
const STATE_SECRET = 'state-secret';
const okHttp: CloudHttpClient = vi.fn(async () => ({
  status: 200,
  headers: {},
  body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'drive.readonly' },
}));
const cfg = {
  clientId: 'cid',
  clientSecret: 'sec',
  redirectUri: 'https://api/cb',
  stateSecret: STATE_SECRET,
  masterKey: MASTER_KEY,
};

let svc: typeof import('../src/services/cloud-oauth.js');
beforeEach(async () => {
  configs = [];
  svc = await import('../src/services/cloud-oauth.js');
});

describe('buildConnectUrl', () => {
  it('signs state that round-trips and is embedded in the authorize URL', () => {
    const url = svc.buildConnectUrl('org1', 'user1', 'gdrive', {
      clientId: 'cid',
      redirectUri: 'https://api/cb',
      stateSecret: STATE_SECRET,
    });
    const state = new URL(url).searchParams.get('state') ?? '';
    expect(verifyOAuthState(state, STATE_SECRET)).toMatchObject({
      orgId: 'org1',
      userId: 'user1',
      provider: 'gdrive',
    });
  });
});

describe('completeConnection', () => {
  it('persists an encrypted, enabled connection on a valid callback', async () => {
    const state = signOAuthState('org1', 'user1', 'gdrive', STATE_SECRET);
    const res = await svc.completeConnection(
      makeDb() as never,
      'gdrive',
      'code',
      state,
      cfg,
      okHttp,
    );
    expect(res).toEqual({ orgId: 'org1' });
    expect(configs[0]).toMatchObject({ orgId: 'org1', type: 'gdrive', enabled: true });
    // The stored blob decrypts back to the token set (never stored in clear).
    const decrypted = JSON.parse(
      decryptCredentials(configs[0]?.encryptedCredentials as string, MASTER_KEY),
    );
    expect(decrypted).toMatchObject({ accessToken: 'AT', refreshToken: 'RT' });
  });

  it('rejects an invalid/forged state', async () => {
    await expect(
      svc.completeConnection(makeDb() as never, 'gdrive', 'code', 'garbage.sig', cfg, okHttp),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('rejects a provider mismatch between state and callback', async () => {
    const state = signOAuthState('org1', 'user1', 'gdrive', STATE_SECRET);
    await expect(
      svc.completeConnection(makeDb() as never, 'dropbox', 'code', state, cfg, okHttp),
    ).rejects.toMatchObject({ code: 'provider_mismatch' });
  });
});
