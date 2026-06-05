// F4.4 — cloud-storage retry/backoff/error-mapping unit tests.

import { describe, expect, it } from 'vitest';

import {
  backoffWithJitter,
  cloudErrorForStatus,
  isRateLimit403Body,
  parseRetryAfter,
} from '@pkg/integrations';

describe('parseRetryAfter', () => {
  it('parses delta-seconds to ms', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(parseRetryAfter('Mon, 01 Jun 2026 00:00:10 GMT', now)).toBe(10_000);
  });

  it('caps an oversized delay at 5 minutes', () => {
    expect(parseRetryAfter('99999')).toBe(5 * 60_000);
  });

  it('returns undefined for missing or unparseable values', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('backoffWithJitter', () => {
  it('returns a jittered value within [0, base * 2^attempt]', () => {
    expect(backoffWithJitter(0, { baseMs: 100, random: () => 0 })).toBe(0);
    expect(backoffWithJitter(3, { baseMs: 100, random: () => 0.5 })).toBe(400); // ceil 800
    expect(backoffWithJitter(0, { baseMs: 100, random: () => 0.99 })).toBeLessThanOrEqual(100);
  });

  it('respects the cap', () => {
    expect(
      backoffWithJitter(20, { baseMs: 1000, capMs: 5000, random: () => 1 }),
    ).toBeLessThanOrEqual(5000);
  });
});

describe('isRateLimit403Body', () => {
  it('detects Drive rate-limit reasons', () => {
    expect(isRateLimit403Body({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } })).toBe(
      true,
    );
  });

  it('ignores genuine auth 403s and malformed bodies', () => {
    expect(isRateLimit403Body({ error: { errors: [{ reason: 'insufficientPermissions' }] } })).toBe(
      false,
    );
    expect(isRateLimit403Body({})).toBe(false);
    expect(isRateLimit403Body(null)).toBe(false);
  });
});

describe('cloudErrorForStatus', () => {
  it('maps 429 + Retry-After to a retryable rate_limited error', () => {
    expect(cloudErrorForStatus(429, 'x', { 'retry-after': '12' })).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 12_000,
    });
  });

  it('maps a Drive 403 rate-limit body to retryable', () => {
    expect(
      cloudErrorForStatus(403, 'x', {}, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
    ).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('maps plain 401/403 to non-retryable auth', () => {
    expect(cloudErrorForStatus(401, 'x')).toMatchObject({ code: 'auth', retryable: false });
    expect(cloudErrorForStatus(403, 'x')).toMatchObject({ code: 'auth', retryable: false });
  });

  it('maps 404, 5xx and other 4xx', () => {
    expect(cloudErrorForStatus(404, 'x')).toMatchObject({ code: 'not_found' });
    expect(cloudErrorForStatus(503, 'x')).toMatchObject({ code: 'transient', retryable: true });
    expect(cloudErrorForStatus(400, 'x')).toMatchObject({ code: 'invalid' });
  });
});
