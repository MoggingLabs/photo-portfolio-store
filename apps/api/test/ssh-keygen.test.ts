// F4.2 — SSH key generation unit tests (real node:crypto).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { generateSftpKey } from '../src/lib/ssh-keygen.js';

describe('generateSftpKey', () => {
  it('renders an OpenSSH ed25519 public key with the comment', () => {
    const k = generateSftpKey('evt_abc');
    expect(k.opensshPublicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* evt_abc$/);
  });

  it('produces a SHA256 fingerprint matching the wire blob', () => {
    const k = generateSftpKey('evt_abc');
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    // Recompute from the public key blob and compare.
    const b64 = k.opensshPublicKey.split(' ')[1] as string;
    const wire = Buffer.from(b64, 'base64');
    const expected = `SHA256:${createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
    expect(k.fingerprint).toBe(expected);
  });

  it('returns a PKCS8 PEM private key', () => {
    const k = generateSftpKey('evt_abc');
    expect(k.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('generates a unique key on each call', () => {
    expect(generateSftpKey('x').fingerprint).not.toBe(generateSftpKey('x').fingerprint);
  });
});
