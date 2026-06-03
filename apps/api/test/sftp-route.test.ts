// F4.2 — SFTP route HTTP tests. Service stubbed; RBAC stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  provisionSftp: vi.fn(),
  rotateSftp: vi.fn(),
  disableSftp: vi.fn(),
  getSftpAccount: vi.fn(),
}));

// importOriginal loads the real service, which destructures schema.sftp.
vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: { sftp: { sftpAccounts: {} } },
}));
vi.mock('../src/services/sftp.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/sftp.js')>();
  return {
    ...actual,
    provisionSftp: hoisted.provisionSftp,
    rotateSftp: hoisted.rotateSftp,
    disableSftp: hoisted.disableSftp,
    getSftpAccount: hoisted.getSftpAccount,
  };
});

const EV = '11111111-2222-3333-4444-555555555555';

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/sftp.js');
  const app = Fastify({ logger: false });
  app.decorate('requirePermission', () => async () => undefined);
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/events/:id/sftp/provision', () => {
  it('201 with the one-time private key', async () => {
    hoisted.provisionSftp.mockResolvedValue({
      systemUsername: 'evt_x',
      chrootPath: '/srv/sftp/x',
      publicKeyFingerprint: 'SHA256:abc',
      status: 'active',
      opensshPublicKey: 'ssh-ed25519 AAAA evt_x',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----',
    });
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/events/${EV}/sftp/provision` });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { privateKeyPem: string }).privateKeyPem).toContain('PRIVATE KEY');
  });

  it('409 when already provisioned', async () => {
    const { SftpError } = await import('../src/services/sftp.js');
    hoisted.provisionSftp.mockRejectedValue(new SftpError('already_provisioned', 'exists'));
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/events/${EV}/sftp/provision` });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /v1/events/:id/sftp/rotate', () => {
  it('200 with a new key', async () => {
    hoisted.rotateSftp.mockResolvedValue({
      systemUsername: 'evt_x',
      chrootPath: '/srv/sftp/x',
      publicKeyFingerprint: 'SHA256:def',
      status: 'active',
      opensshPublicKey: 'ssh-ed25519 BBBB evt_x',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----',
    });
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/events/${EV}/sftp/rotate` });
    expect(res.statusCode).toBe(200);
  });

  it('404 when no account exists', async () => {
    const { SftpError } = await import('../src/services/sftp.js');
    hoisted.rotateSftp.mockRejectedValue(new SftpError('not_found', 'nope'));
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/events/${EV}/sftp/rotate` });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE + GET /v1/events/:id/sftp', () => {
  it('204 disables the account', async () => {
    hoisted.disableSftp.mockResolvedValue(undefined);
    app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/v1/events/${EV}/sftp` });
    expect(res.statusCode).toBe(204);
  });

  it('404 when no account on GET', async () => {
    hoisted.getSftpAccount.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/events/${EV}/sftp` });
    expect(res.statusCode).toBe(404);
  });

  it('200 with status (no key material) on GET', async () => {
    hoisted.getSftpAccount.mockResolvedValue({
      systemUsername: 'evt_x',
      chrootPath: '/srv/sftp/x',
      publicKeyFingerprint: 'SHA256:abc',
      status: 'active',
    });
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/events/${EV}/sftp` });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('PRIVATE KEY');
  });
});
