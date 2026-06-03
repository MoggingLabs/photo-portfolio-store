// F4.2 — SFTP provisioning service tests (fake in-memory db, real keygen).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    sftp: {
      sftpAccounts: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        systemUsername: { column: 'systemUsername' },
        chrootPath: { column: 'chrootPath' },
        publicKeyFingerprint: { column: 'publicKeyFingerprint' },
        status: { column: 'status' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => {
  type F = { column: string };
  const isF = (v: unknown): v is F => typeof v === 'object' && v !== null && 'column' in (v as F);
  const val = (v: unknown, r: Record<string, unknown>) => (isF(v) ? r[v.column] : v);
  return {
    and:
      (...p: Array<(r: Record<string, unknown>) => boolean>) =>
      (r: Record<string, unknown>) =>
        p.every((f) => f(r)),
    eq: (a: unknown, b: unknown) => (r: Record<string, unknown>) => val(a, r) === val(b, r),
  };
});

type Row = Record<string, unknown>;
let rows: Row[];

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      from: () => api,
      where: (p: (r: Row) => boolean) => {
        filters.push(p);
        return api;
      },
      limit: () =>
        Promise.resolve(
          rows
            .filter((r) => filters.every((f) => f(r)))
            .map((r) => {
              const o: Row = {};
              for (const [a, ref] of Object.entries(sel)) o[a] = r[ref.column];
              return o;
            }),
        ),
    };
    return api;
  };
  const insert = () => ({ values: (v: Row) => Promise.resolve(rows.push({ ...v }) && undefined) });
  const update = () => ({
    set: (s: Row) => ({
      where: (p: (r: Row) => boolean) => {
        for (const r of rows) if (p(r)) Object.assign(r, s);
        return Promise.resolve();
      },
    }),
  });
  return { select, insert, update } as never;
};

let svc: typeof import('../src/services/sftp.js');

beforeEach(async () => {
  rows = [];
  svc = await import('../src/services/sftp.js');
});

const EV = '11111111-2222-3333-4444-555555555555';

describe('provisionSftp', () => {
  it('creates an account and returns the private key once', async () => {
    const r = await svc.provisionSftp(makeDb(), EV);
    expect(r.systemUsername).toMatch(/^evt_/);
    expect(r.chrootPath).toContain(EV);
    expect(r.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(r.publicKeyFingerprint).toMatch(/^SHA256:/);
    // Only the fingerprint is persisted, never the private key.
    expect(rows[0]?.publicKeyFingerprint).toBe(r.publicKeyFingerprint);
    expect(JSON.stringify(rows[0])).not.toContain('PRIVATE KEY');
  });

  it('refuses to provision twice (use rotate)', async () => {
    const db = makeDb();
    await svc.provisionSftp(db, EV);
    await expect(svc.provisionSftp(db, EV)).rejects.toMatchObject({ code: 'already_provisioned' });
  });
});

describe('rotateSftp', () => {
  it('mints a new fingerprint and stamps last_rotated_at', async () => {
    const db = makeDb();
    const first = await svc.provisionSftp(db, EV);
    const rotated = await svc.rotateSftp(db, EV);
    expect(rotated.publicKeyFingerprint).not.toBe(first.publicKeyFingerprint);
    expect(rows[0]?.lastRotatedAt).toBeInstanceOf(Date);
  });

  it('404s when there is no account', async () => {
    await expect(svc.rotateSftp(makeDb(), EV)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('disableSftp', () => {
  it('sets status to disabled', async () => {
    const db = makeDb();
    await svc.provisionSftp(db, EV);
    await svc.disableSftp(db, EV);
    expect(rows[0]?.status).toBe('disabled');
  });
});
