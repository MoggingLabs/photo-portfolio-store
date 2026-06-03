// F4.2 — per-event SFTP account provisioning.
//
// Provision generates an ed25519 key pair, installs the public key fingerprint
// + chroot path on a one-account-per-event row, and returns the private key
// exactly once. Rotate mints a new key (invalidating the old). Delete disables
// the account. The private key is never persisted; only the fingerprint is.
//
// The actual OpenSSH chroot user, authorized_keys install, fail2ban, and the
// staging-dir watcher are deploy-side infra (see docs/integrations/sftp.md);
// this service owns the account lifecycle + key material.

import { type DbClient, schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';

import { type GeneratedSshKey, generateSftpKey } from '../lib/ssh-keygen.js';

const { sftpAccounts } = schema.sftp;

const SFTP_ROOT = '/srv/sftp';

export class SftpError extends Error {
  constructor(
    public readonly code: 'already_provisioned' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'SftpError';
  }
}

export interface SftpAccountView {
  systemUsername: string;
  chrootPath: string;
  publicKeyFingerprint: string;
  status: string;
}

export interface ProvisionResult extends SftpAccountView {
  opensshPublicKey: string;
  // Returned exactly once — never stored.
  privateKeyPem: string;
}

const usernameFor = (eventId: string): string => `evt_${eventId.replace(/-/g, '').slice(0, 16)}`;
const chrootFor = (eventId: string): string => `${SFTP_ROOT}/${eventId}`;

const view = (row: {
  systemUsername: string;
  chrootPath: string;
  publicKeyFingerprint: string;
  status: string;
}): SftpAccountView => ({
  systemUsername: row.systemUsername,
  chrootPath: row.chrootPath,
  publicKeyFingerprint: row.publicKeyFingerprint,
  status: row.status,
});

export const provisionSftp = async (db: DbClient, eventId: string): Promise<ProvisionResult> => {
  const existing = await db
    .select({ id: sftpAccounts.id })
    .from(sftpAccounts)
    .where(eq(sftpAccounts.eventId, eventId))
    .limit(1);
  if (existing[0]) {
    throw new SftpError('already_provisioned', 'event already has an SFTP account; rotate instead');
  }

  const username = usernameFor(eventId);
  const chrootPath = chrootFor(eventId);
  const key: GeneratedSshKey = generateSftpKey(username);

  await db.insert(sftpAccounts).values({
    eventId,
    systemUsername: username,
    publicKeyFingerprint: key.fingerprint,
    chrootPath,
    status: 'active',
  });

  return {
    systemUsername: username,
    chrootPath,
    publicKeyFingerprint: key.fingerprint,
    status: 'active',
    opensshPublicKey: key.opensshPublicKey,
    privateKeyPem: key.privateKeyPem,
  };
};

export const rotateSftp = async (db: DbClient, eventId: string): Promise<ProvisionResult> => {
  const rows = await db
    .select({ systemUsername: sftpAccounts.systemUsername, chrootPath: sftpAccounts.chrootPath })
    .from(sftpAccounts)
    .where(eq(sftpAccounts.eventId, eventId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new SftpError('not_found', 'no SFTP account to rotate');

  const key = generateSftpKey(row.systemUsername);
  await db
    .update(sftpAccounts)
    .set({
      publicKeyFingerprint: key.fingerprint,
      status: 'active',
      lastRotatedAt: new Date(),
    })
    .where(eq(sftpAccounts.eventId, eventId));

  return {
    systemUsername: row.systemUsername,
    chrootPath: row.chrootPath,
    publicKeyFingerprint: key.fingerprint,
    status: 'active',
    opensshPublicKey: key.opensshPublicKey,
    privateKeyPem: key.privateKeyPem,
  };
};

export const disableSftp = async (db: DbClient, eventId: string): Promise<void> => {
  await db
    .update(sftpAccounts)
    .set({ status: 'disabled' })
    .where(and(eq(sftpAccounts.eventId, eventId), eq(sftpAccounts.status, 'active')));
};

export const getSftpAccount = async (
  db: DbClient,
  eventId: string,
): Promise<SftpAccountView | null> => {
  const rows = await db
    .select({
      systemUsername: sftpAccounts.systemUsername,
      chrootPath: sftpAccounts.chrootPath,
      publicKeyFingerprint: sftpAccounts.publicKeyFingerprint,
      status: sftpAccounts.status,
    })
    .from(sftpAccounts)
    .where(eq(sftpAccounts.eventId, eventId))
    .limit(1);
  return rows[0] ? view(rows[0]) : null;
};
