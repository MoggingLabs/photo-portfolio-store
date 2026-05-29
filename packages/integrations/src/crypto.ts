// Envelope encryption for connector credentials at rest (F4.1).
//
// No cloud KMS is available locally, so the master key is supplied by the
// caller (read from INTEGRATIONS_MASTER_KEY env at the edge and passed in here,
// never imported, so this package stays dependency-free and unit-testable).
//
// Scheme: a fresh 256-bit data-encryption key (DEK) is generated per record,
// used to AES-256-GCM encrypt the plaintext, then itself wrapped (AES-256-GCM)
// under the master key. Storing a per-record DEK means master-key rotation only
// rewraps DEKs, never re-encrypts payloads. The serialized blob is versioned so
// the format can evolve.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const _TAG_BYTES = 16;

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

interface EnvelopeBlob {
  v: number;
  wrappedDek: string; // base64: GCM(masterKey, dek)
  dekIv: string;
  dekTag: string;
  iv: string; // base64: payload GCM nonce
  tag: string;
  ct: string; // base64: ciphertext
}

const decodeMasterKey = (masterKeyB64: string): Buffer => {
  let key: Buffer;
  try {
    key = Buffer.from(masterKeyB64, 'base64');
  } catch {
    throw new CredentialCryptoError('master key is not valid base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `master key must be ${KEY_BYTES} bytes (got ${key.length}); generate with: openssl rand -base64 32`,
    );
  }
  return key;
};

const gcmEncrypt = (key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
};

const gcmDecrypt = (key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer => {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
};

/**
 * Encrypt a credential string into a versioned, serialized envelope blob safe
 * to persist in `integration_configs.encrypted_credentials`.
 */
export const encryptCredentials = (plaintext: string, masterKeyB64: string): string => {
  const masterKey = decodeMasterKey(masterKeyB64);
  const dek = randomBytes(KEY_BYTES);

  const payload = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'));
  const wrapped = gcmEncrypt(masterKey, dek);

  const blob: EnvelopeBlob = {
    v: VERSION,
    wrappedDek: wrapped.ct.toString('base64'),
    dekIv: wrapped.iv.toString('base64'),
    dekTag: wrapped.tag.toString('base64'),
    iv: payload.iv.toString('base64'),
    tag: payload.tag.toString('base64'),
    ct: payload.ct.toString('base64'),
  };
  return Buffer.from(JSON.stringify(blob), 'utf8').toString('base64');
};

/**
 * Decrypt a blob produced by {@link encryptCredentials}. Throws
 * CredentialCryptoError on a wrong master key, tampered ciphertext, or an
 * unrecognised version.
 */
export const decryptCredentials = (blob: string, masterKeyB64: string): string => {
  const masterKey = decodeMasterKey(masterKeyB64);
  let parsed: EnvelopeBlob;
  try {
    parsed = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as EnvelopeBlob;
  } catch {
    throw new CredentialCryptoError('credential blob is malformed');
  }
  if (parsed.v !== VERSION) {
    throw new CredentialCryptoError(`unsupported credential blob version ${parsed.v}`);
  }
  try {
    const dek = gcmDecrypt(
      masterKey,
      Buffer.from(parsed.dekIv, 'base64'),
      Buffer.from(parsed.dekTag, 'base64'),
      Buffer.from(parsed.wrappedDek, 'base64'),
    );
    if (dek.length !== KEY_BYTES) throw new CredentialCryptoError('unwrapped DEK has wrong length');
    const plaintext = gcmDecrypt(
      dek,
      Buffer.from(parsed.iv, 'base64'),
      Buffer.from(parsed.tag, 'base64'),
      Buffer.from(parsed.ct, 'base64'),
    );
    return plaintext.toString('utf8');
  } catch (err) {
    if (err instanceof CredentialCryptoError) throw err;
    throw new CredentialCryptoError('credential decryption failed (wrong key or tampered blob)');
  }
};
