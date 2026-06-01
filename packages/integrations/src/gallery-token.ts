// F4.12 — signed gallery deep-link tokens.
//
// A short-lived (default 24h) HMAC-signed token granting a participant access
// to their personal gallery without logging in. Format:
//   base64url(JSON payload) + "." + base64url(hmac_sha256(secret, payloadB64))
// The signing secret is supplied by the caller (read from env at the edge).

import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SEC = 24 * 60 * 60;

export interface GalleryTokenClaims {
  participantId: string;
  eventId: string;
  /** Unix seconds expiry. */
  exp: number;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

const sign = (payloadB64: string, secret: string): string =>
  b64url(createHmac('sha256', secret).update(payloadB64).digest());

export interface SignGalleryTokenOptions {
  ttlSec?: number;
  /** Current unix seconds; injectable for tests. */
  nowSec?: number;
}

export const signGalleryToken = (
  participantId: string,
  eventId: string,
  secret: string,
  opts: SignGalleryTokenOptions = {},
): string => {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const claims: GalleryTokenClaims = {
    participantId,
    eventId,
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
 * Verify a gallery token. Returns the claims when the signature is valid and
 * the token has not expired, otherwise null.
 */
export const verifyGalleryToken = (
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): GalleryTokenClaims | null => {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!safeEqual(sigB64, sign(payloadB64, secret))) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as GalleryTokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp < nowSec) return null;
    if (typeof claims.participantId !== 'string' || typeof claims.eventId !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
};
