// Outbound webhook HMAC signing + verification (F4.11).
//
// Signature scheme (sender and receiver must agree):
//   X-Webhook-Signature: sha256=<hex(hmac_sha256(secret, `${timestamp}.${body}`))>
//   X-Webhook-Timestamp: <unix seconds>
// Binding the timestamp into the signed payload prevents replay with a stale
// body. Receivers should additionally reject timestamps drifting more than a
// few minutes (verifyWebhookSignature enforces a tolerance).

import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_PREFIX = 'sha256=';
const DEFAULT_TOLERANCE_SEC = 300; // 5 minutes

export const signWebhookBody = (secret: string, timestamp: number, body: string): string => {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `${SIG_PREFIX}${mac}`;
};

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

export interface VerifyOptions {
  toleranceSec?: number;
  /** Current unix seconds; injectable for tests. */
  nowSec?: number;
}

/**
 * Verify a webhook signature and timestamp freshness. Returns true only when
 * the HMAC matches AND the timestamp is within tolerance of now. Constant-time
 * comparison avoids signature-timing leaks.
 */
export const verifyWebhookSignature = (
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  opts: VerifyOptions = {},
): boolean => {
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > tolerance) return false;
  return safeEqual(signature, signWebhookBody(secret, timestamp, body));
};
