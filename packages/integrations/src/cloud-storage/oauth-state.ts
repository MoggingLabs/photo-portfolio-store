// F4.4 — OAuth `state` parameter signing (stateless CSRF protection).
//
// Same construction as the gallery token: base64url(JSON) + "." +
// base64url(hmac_sha256(secret, payloadB64)). It carries the org + user that
// initiated the connect so the public callback (which has no bearer auth) can
// attribute the connection and reject forged/expired callbacks without a
// server-side state table.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CloudProvider } from './types.js';

// OAuth round-trips complete in minutes; keep state short-lived.
const DEFAULT_TTL_SEC = 10 * 60;

export interface OAuthStateClaims {
  orgId: string;
  userId: string;
  provider: CloudProvider;
  /** Unix seconds expiry. */
  exp: number;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

const sign = (payloadB64: string, secret: string): string =>
  b64url(createHmac('sha256', secret).update(payloadB64).digest());

export interface SignOAuthStateOptions {
  ttlSec?: number;
  /** Current unix seconds; injectable for tests. */
  nowSec?: number;
}

export const signOAuthState = (
  orgId: string,
  userId: string,
  provider: CloudProvider,
  secret: string,
  opts: SignOAuthStateOptions = {},
): string => {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const claims: OAuthStateClaims = {
    orgId,
    userId,
    provider,
    exp: now + (opts.ttlSec ?? DEFAULT_TTL_SEC),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
};

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/**
 * Verify a signed OAuth state. Returns the claims when the signature is valid,
 * the token has not expired, and the provider is recognized; otherwise null.
 */
export const verifyOAuthState = (
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): OAuthStateClaims | null => {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!safeEqual(sigB64, sign(payloadB64, secret))) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as OAuthStateClaims;
    if (typeof claims.exp !== 'number' || claims.exp < nowSec) return null;
    if (typeof claims.orgId !== 'string' || typeof claims.userId !== 'string') return null;
    if (claims.provider !== 'gdrive' && claims.provider !== 'dropbox') return null;
    return claims;
  } catch {
    return null;
  }
};
