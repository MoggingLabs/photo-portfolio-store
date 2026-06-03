// F4.2 — per-event SFTP key generation.
//
// Generates an ed25519 key pair and renders the public key in OpenSSH
// authorized_keys format plus its SHA256 fingerprint. The private key is
// returned (PKCS8 PEM) exactly once at provision/rotate time and never stored.

import { createHash, generateKeyPairSync } from 'node:crypto';

export interface GeneratedSshKey {
  // "ssh-ed25519 AAAA... <comment>"
  opensshPublicKey: string;
  // PKCS8 PEM — returned once, never persisted.
  privateKeyPem: string;
  // "SHA256:<base64 no-pad>" — the value we persist for the account.
  fingerprint: string;
}

// SSH wire string: uint32 big-endian length prefix + bytes.
const sshString = (buf: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
};

export const generateSftpKey = (comment: string): GeneratedSshKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const raw = Buffer.from(jwk.x, 'base64url'); // 32-byte ed25519 public key

  const wire = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(raw)]);
  const b64 = wire.toString('base64');
  const fingerprint = `SHA256:${createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;

  return {
    opensshPublicKey: `ssh-ed25519 ${b64} ${comment}`.trim(),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    fingerprint,
  };
};
