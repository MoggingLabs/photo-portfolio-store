// F4.4 — OAuth state sign/verify unit tests.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { signOAuthState, verifyOAuthState } from '@pkg/integrations';

const SECRET = 'state-secret';

describe('oauth state', () => {
  it('signs and verifies before expiry', () => {
    const now = 1_800_000_000;
    const token = signOAuthState('org1', 'user1', 'gdrive', SECRET, { nowSec: now });
    expect(verifyOAuthState(token, SECRET, now + 60)).toMatchObject({
      orgId: 'org1',
      userId: 'user1',
      provider: 'gdrive',
    });
  });

  it('rejects after expiry', () => {
    const now = 1_800_000_000;
    const token = signOAuthState('o', 'u', 'dropbox', SECRET, { nowSec: now, ttlSec: 100 });
    expect(verifyOAuthState(token, SECRET, now + 101)).toBeNull();
  });

  it('rejects a wrong secret and a tampered payload', () => {
    const now = 1_800_000_000;
    const token = signOAuthState('o', 'u', 'gdrive', SECRET, { nowSec: now });
    expect(verifyOAuthState(token, 'other', now)).toBeNull();
    const [, sig] = token.split('.');
    const forged = `${Buffer.from('{"orgId":"hax","userId":"u","provider":"gdrive","exp":9999999999}').toString('base64url')}.${sig}`;
    expect(verifyOAuthState(forged, SECRET, now)).toBeNull();
  });

  it('rejects an unknown provider even when correctly signed', () => {
    const now = 1_800_000_000;
    const payload = Buffer.from(
      JSON.stringify({ orgId: 'o', userId: 'u', provider: 'onedrive', exp: now + 60 }),
    ).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest().toString('base64url');
    expect(verifyOAuthState(`${payload}.${sig}`, SECRET, now)).toBeNull();
  });
});
