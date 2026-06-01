// F4.12 — gallery token + quiet-hours unit tests.

import { describe, expect, it } from 'vitest';

import { isQuietHours, localHour, signGalleryToken, verifyGalleryToken } from '@pkg/integrations';

const SECRET = 'gallery-secret';

describe('gallery token', () => {
  it('signs and verifies a token before expiry', () => {
    const now = 1_800_000_000;
    const token = signGalleryToken('p1', 'e1', SECRET, { nowSec: now });
    const claims = verifyGalleryToken(token, SECRET, now + 60);
    expect(claims).toMatchObject({ participantId: 'p1', eventId: 'e1' });
  });

  it('rejects after expiry', () => {
    const now = 1_800_000_000;
    const token = signGalleryToken('p1', 'e1', SECRET, { nowSec: now, ttlSec: 100 });
    expect(verifyGalleryToken(token, SECRET, now + 101)).toBeNull();
  });

  it('rejects a wrong secret and a tampered payload', () => {
    const now = 1_800_000_000;
    const token = signGalleryToken('p1', 'e1', SECRET, { nowSec: now });
    expect(verifyGalleryToken(token, 'other', now)).toBeNull();
    const [payload, sig] = token.split('.');
    const tampered = `${Buffer.from('{"participantId":"hax","eventId":"e1","exp":9999999999}').toString('base64url')}.${sig}`;
    expect(verifyGalleryToken(tampered, SECRET, now)).toBeNull();
    expect(payload).toBeTruthy();
  });
});

describe('quiet hours', () => {
  it('computes local hour from a coarse locale offset', () => {
    // 12:00 UTC, pt-BR (-3) -> 09:00 local.
    expect(localHour(new Date('2026-06-01T12:00:00Z'), 'pt-BR')).toBe(9);
    // unknown locale -> UTC.
    expect(localHour(new Date('2026-06-01T12:00:00Z'), 'xx-YY')).toBe(12);
  });

  it('flags quiet hours before 8am / after 9pm local', () => {
    // 02:00 UTC, en-GB (0) -> 02:00 local -> quiet.
    expect(isQuietHours(new Date('2026-06-01T02:00:00Z'), 'en-GB')).toBe(true);
    // 14:00 UTC, en-GB -> 14:00 -> not quiet.
    expect(isQuietHours(new Date('2026-06-01T14:00:00Z'), 'en-GB')).toBe(false);
    // 23:00 UTC, en-GB -> 23:00 -> quiet.
    expect(isQuietHours(new Date('2026-06-01T23:00:00Z'), 'en-GB')).toBe(true);
  });
});
