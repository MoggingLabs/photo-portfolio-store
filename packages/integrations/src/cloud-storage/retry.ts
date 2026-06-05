// F4.4 — rate-limit + transient-error handling for cloud-storage adapters.
//
// Dropbox throttles with 429 + Retry-After; Google Drive usually returns 403
// with reason 'rateLimitExceeded' / 'userRateLimitExceeded' and no header.
// parseRetryAfter honors an explicit server delay; backoffWithJitter is the
// fallback for 5xx and header-less throttles.

import { CloudStorageError } from './types.js';

// Cap a server-sent delay so a hostile/buggy Retry-After cannot stall a sweep.
const MAX_RETRY_AFTER_MS = 5 * 60_000;

// Parse an HTTP Retry-After value (delta-seconds or an HTTP-date) to ms.
// `nowMs` is injectable for deterministic tests of the date branch.
export const parseRetryAfter = (
  value: string | undefined,
  nowMs: number = Date.now(),
): number | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.min(Math.max(dateMs - nowMs, 0), MAX_RETRY_AFTER_MS);
};

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  // Injectable RNG for deterministic tests.
  random?: () => number;
}

// Exponential backoff with full jitter: a random delay in [0, base * 2^attempt],
// capped. `attempt` is 0-based.
export const backoffWithJitter = (attempt: number, opts: BackoffOptions = {}): number => {
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
};

// Google Drive surfaces rate limits as a 403 with a reason field; treat those as
// retryable rather than a fatal auth error.
const DRIVE_RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'backendError',
]);

export const isRateLimit403Body = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: { errors?: Array<{ reason?: string }> } }).error;
  if (!error || !Array.isArray(error.errors)) return false;
  return error.errors.some(
    (e) => typeof e.reason === 'string' && DRIVE_RATE_LIMIT_REASONS.has(e.reason),
  );
};

// Map an HTTP status (+ optional headers/body) onto a CloudStorageError with the
// correct retryable flag, used uniformly by both provider adapters.
export const cloudErrorForStatus = (
  status: number,
  message: string,
  headers: Record<string, string> = {},
  body?: unknown,
): CloudStorageError => {
  if (status === 429) {
    return new CloudStorageError(
      'rate_limited',
      message,
      true,
      parseRetryAfter(headers['retry-after']),
    );
  }
  if (status === 403 && isRateLimit403Body(body)) {
    return new CloudStorageError('rate_limited', message, true);
  }
  if (status === 401 || status === 403) return new CloudStorageError('auth', message);
  if (status === 404) return new CloudStorageError('not_found', message);
  if (status >= 500) return new CloudStorageError('transient', message, true);
  return new CloudStorageError('invalid', message);
};
