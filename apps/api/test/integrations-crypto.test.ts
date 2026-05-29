// F4.1 — credential envelope-encryption + redaction unit tests.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CredentialCryptoError,
  decryptCredentials,
  encryptCredentials,
  redactSecrets,
} from '@pkg/integrations';

const key = () => randomBytes(32).toString('base64');

describe('credential crypto', () => {
  it('round-trips a credential string', () => {
    const k = key();
    const secret = JSON.stringify({ apiKey: 'rsu_live_abc123', baseUrl: 'https://x' });
    const blob = encryptCredentials(secret, k);
    expect(blob).not.toContain('rsu_live_abc123'); // ciphertext, not plaintext
    expect(decryptCredentials(blob, k)).toBe(secret);
  });

  it('produces different ciphertext for the same plaintext (random DEK/IV)', () => {
    const k = key();
    expect(encryptCredentials('same', k)).not.toBe(encryptCredentials('same', k));
  });

  it('fails to decrypt with the wrong master key', () => {
    const blob = encryptCredentials('secret', key());
    expect(() => decryptCredentials(blob, key())).toThrow(CredentialCryptoError);
  });

  it('fails to decrypt a tampered blob', () => {
    const k = key();
    const blob = encryptCredentials('secret', k);
    const bytes = Buffer.from(blob, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip a ciphertext bit
    const tampered = bytes.toString('base64');
    expect(() => decryptCredentials(tampered, k)).toThrow(CredentialCryptoError);
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => encryptCredentials('x', Buffer.from('short').toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});

describe('redactSecrets', () => {
  it('masks keys that look secret, at any depth', () => {
    const out = redactSecrets({
      type: 'runsignup',
      encrypted_credentials: 'blob',
      nested: { apiKey: 'k', api_key: 'k2', token: 't', safe: 'ok' },
      list: [{ password: 'p' }],
    });
    expect(out.encrypted_credentials).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.api_key).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.nested.safe).toBe('ok');
    expect(out.list[0]?.password).toBe('[REDACTED]');
    expect(out.type).toBe('runsignup');
  });

  it('returns primitives unchanged', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets('hi')).toBe('hi');
    expect(redactSecrets(null)).toBeNull();
  });
});
