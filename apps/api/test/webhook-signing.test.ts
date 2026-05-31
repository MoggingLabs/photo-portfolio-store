// F4.11 — webhook signing + SSRF guard unit tests.

import { describe, expect, it } from 'vitest';

import {
  SsrfError,
  assertPublicHttpsUrl,
  signWebhookBody,
  verifyWebhookSignature,
} from '@pkg/integrations';

describe('signWebhookBody / verifyWebhookSignature', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ event: 'order.paid', id: 'abc' });

  it('produces a sha256= prefixed hex signature', () => {
    const sig = signWebhookBody(secret, 1700000000, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('verifies a fresh, correctly-signed payload', () => {
    const ts = 1700000000;
    const sig = signWebhookBody(secret, ts, body);
    expect(verifyWebhookSignature(secret, ts, body, sig, { nowSec: ts + 10 })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = 1700000000;
    const sig = signWebhookBody(secret, ts, body);
    expect(verifyWebhookSignature(secret, ts, `${body} `, sig, { nowSec: ts })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const ts = 1700000000;
    const sig = signWebhookBody(secret, ts, body);
    expect(verifyWebhookSignature('other', ts, body, sig, { nowSec: ts })).toBe(false);
  });

  it('rejects a stale timestamp beyond tolerance', () => {
    const ts = 1700000000;
    const sig = signWebhookBody(secret, ts, body);
    expect(verifyWebhookSignature(secret, ts, body, sig, { nowSec: ts + 1000 })).toBe(false);
  });
});

describe('assertPublicHttpsUrl', () => {
  it('accepts a normal public https URL', () => {
    expect(() => assertPublicHttpsUrl('https://hooks.example.com/x')).not.toThrow();
  });

  it('rejects http by default', () => {
    expect(() => assertPublicHttpsUrl('http://hooks.example.com/x')).toThrow(SsrfError);
  });

  it('allows http when explicitly opted in (local dev)', () => {
    expect(() =>
      assertPublicHttpsUrl('http://hooks.example.com/x', { allowHttp: true }),
    ).not.toThrow();
  });

  it('blocks loopback and localhost', () => {
    expect(() => assertPublicHttpsUrl('https://127.0.0.1/x')).toThrow(SsrfError);
    expect(() => assertPublicHttpsUrl('https://localhost/x')).toThrow(SsrfError);
    expect(() => assertPublicHttpsUrl('https://[::1]/x')).toThrow(SsrfError);
  });

  it('blocks the cloud metadata address and private ranges', () => {
    expect(() => assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      SsrfError,
    );
    expect(() => assertPublicHttpsUrl('https://10.0.0.5/x')).toThrow(SsrfError);
    expect(() => assertPublicHttpsUrl('https://192.168.1.1/x')).toThrow(SsrfError);
    expect(() => assertPublicHttpsUrl('https://172.16.0.1/x')).toThrow(SsrfError);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertPublicHttpsUrl('not a url')).toThrow(SsrfError);
  });
});
