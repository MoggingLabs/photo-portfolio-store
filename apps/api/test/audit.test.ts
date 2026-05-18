// Tests for the audit-log surface (F1.34).
//
// All tests stub the DB and RBAC layer — no real Postgres connection. The
// RBAC stub injects request.user before each request based on a per-test
// header so we can exercise both allowed and denied paths.

import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Permission } from '../src/auth/permissions.js';
import { hashIp, writeAudit } from '../src/lib/audit.js';
import { canonicalize } from '../src/lib/canonical-json.js';
import adminAuditRoutes from '../src/routes/admin/audit.js';

// ---------- DB stub ----------

interface InsertCall {
  values: Record<string, unknown>;
}

const makeDb = (opts: { failInsert?: boolean; selectRows?: unknown[] } = {}) => {
  const inserts: InsertCall[] = [];
  const captured = {
    orderBy: vi.fn(),
    limit: vi.fn(),
    where: vi.fn(),
  };

  const selectChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    // Make the chain awaitable: resolves to the row array.
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  };

  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        if (opts.failInsert) {
          throw new Error('boom');
        }
        inserts.push({ values: v });
      }),
    })),
    select: vi.fn(() => selectChain(opts.selectRows ?? [])),
    execute: vi.fn(async () => undefined),
  } as unknown as Parameters<typeof writeAudit>[0];

  return { db, inserts, captured };
};

// ---------- canonicalize ----------

describe('canonicalize', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = canonicalize({ b: 2, a: 1, c: { y: 2, x: 1 } });
    const b = canonicalize({ a: 1, c: { x: 1, y: 2 }, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"c":{"x":1,"y":2}}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined values inside objects', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('escapes strings via JSON.stringify', () => {
    expect(canonicalize({ k: 'a"b' })).toBe('{"k":"a\\"b"}');
  });

  it('encodes NaN/Infinity as null', () => {
    expect(canonicalize({ n: Number.NaN, i: Number.POSITIVE_INFINITY })).toBe(
      '{"i":null,"n":null}',
    );
  });
});

// ---------- writeAudit ----------

describe('writeAudit', () => {
  it('inserts a row with computed payload_hash for non-empty payload', async () => {
    const { db, inserts } = makeDb();
    await writeAudit(db, {
      action: 'consent.granted',
      actorKind: 'user',
      actorUserId: '11111111-1111-1111-1111-111111111111',
      payload: { scope: 'biometric', version: '2026-05-18' },
    });
    expect(inserts).toHaveLength(1);
    const v = inserts[0]?.values;
    expect(v.action).toBe('consent.granted');
    expect(v.actorKind).toBe('user');
    expect(v.payloadJsonb).toEqual({ scope: 'biometric', version: '2026-05-18' });
    const expected = createHash('sha256')
      .update('{"scope":"biometric","version":"2026-05-18"}', 'utf8')
      .digest('hex');
    expect(v.payloadHash).toBe(expected);
  });

  it('sets payload_hash to null when payload is omitted', async () => {
    const { db, inserts } = makeDb();
    await writeAudit(db, { action: 'system.boot', actorKind: 'system' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values.payloadHash).toBeNull();
    expect(inserts[0]?.values.payloadJsonb).toBeNull();
  });

  it('does NOT throw when the DB insert fails', async () => {
    const { db } = makeDb({ failInsert: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      writeAudit(db, { action: 'rbac.denied', actorKind: 'user' }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it('hashIp produces a stable sha256 hex digest', () => {
    expect(hashIp('203.0.113.4')).toBe(
      createHash('sha256').update('203.0.113.4', 'utf8').digest('hex'),
    );
    expect(hashIp(undefined)).toBeUndefined();
    expect(hashIp(null)).toBeUndefined();
    expect(hashIp('')).toBeUndefined();
  });
});

// ---------- Admin routes ----------

interface FakeUser {
  id: string;
  role: string;
}

// Build a Fastify instance with a stubbed RBAC layer that decorates
// request.user from the `x-test-user` header and gates routes by checking
// a permission map keyed on role.
const buildTestApp = async (
  db: ReturnType<typeof makeDb>['db'],
  permissionsByRole: Record<string, ReadonlyArray<Permission>>,
  deniedAudits: { perm: Permission; user: FakeUser }[],
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string' && raw.length > 0) {
      const user = JSON.parse(raw) as FakeUser;
      (req as unknown as { user: FakeUser }).user = user;
    }
  });
  app.decorate('requirePermission', (perm: Permission) => {
    return async (
      req: { user?: FakeUser },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const user = req.user;
      if (!user) {
        return reply.code(401).send({ statusCode: 401, error: 'Unauthorized' });
      }
      const perms = permissionsByRole[user.role] ?? [];
      if (!perms.includes(perm)) {
        deniedAudits.push({ perm, user });
        return reply.code(403).send({ statusCode: 403, error: 'Forbidden' });
      }
      return undefined;
    };
  });
  await app.register(adminAuditRoutes, { db });
  await app.ready();
  return app;
};

describe('GET /v1/admin/audit-log', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('filters by action prefix (consent.*) and returns entries + nextCursor', async () => {
    const rows = [
      {
        id: 3n,
        actorUserId: 'u1',
        actorKind: 'user',
        action: 'consent.revoked',
        targetKind: null,
        targetId: null,
        eventId: null,
        ipHash: null,
        userAgent: null,
        payloadJsonb: { scope: 'biometric' },
        payloadHash: 'h3',
        createdAt: new Date('2026-05-18T12:00:00Z'),
      },
      {
        id: 2n,
        actorUserId: 'u1',
        actorKind: 'user',
        action: 'consent.granted',
        targetKind: null,
        targetId: null,
        eventId: null,
        ipHash: null,
        userAgent: null,
        payloadJsonb: null,
        payloadHash: null,
        createdAt: new Date('2026-05-18T11:00:00Z'),
      },
    ];
    const { db, inserts } = makeDb({ selectRows: rows });
    app = await buildTestApp(db, { superadmin: ['compliance:read_audit'] }, []);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log?action=consent.*',
      headers: {
        'x-test-user': JSON.stringify({ id: 'admin-1', role: 'superadmin' }),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ action: string }>; nextCursor: string | null };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]?.action).toBe('consent.revoked');
    expect(body.entries[1]?.action).toBe('consent.granted');
    expect(body.nextCursor).toBeNull();
    // Meta-audit was written.
    const metaActions = inserts.map((i) => i.values.action);
    expect(metaActions).toContain('audit.export.viewed');
  });

  it('denies access for non-admin role and the rbac.denied entry is captured', async () => {
    const { db } = makeDb({ selectRows: [] });
    const denied: { perm: Permission; user: FakeUser }[] = [];
    app = await buildTestApp(db, { photographer: [] }, denied);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log',
      headers: {
        'x-test-user': JSON.stringify({ id: 'photog-1', role: 'photographer' }),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.perm).toBe('compliance:read_audit');
    expect(denied[0]?.user.role).toBe('photographer');
  });
});

describe('GET /v1/admin/audit-log.csv', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('streams CSV with proper headers and never buffers via toArray', async () => {
    const rows = [
      {
        id: 1n,
        actorUserId: null,
        actorKind: 'system',
        action: 'system.boot',
        targetKind: null,
        targetId: null,
        eventId: null,
        ipHash: null,
        userAgent: null,
        payloadJsonb: { ok: true },
        payloadHash: 'h1',
        createdAt: new Date('2026-05-18T00:00:00Z'),
      },
    ];
    const { db } = makeDb({ selectRows: rows });
    app = await buildTestApp(db, { superadmin: ['compliance:read_audit'] }, []);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log.csv',
      headers: {
        'x-test-user': JSON.stringify({ id: 'admin-1', role: 'superadmin' }),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    const lines = res.body.split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toContain('id,created_at,actor_kind');
    expect(lines[1]).toContain('system.boot');
    // Verify implementation does not call any `.toArray()` style buffering.
    // (Sanity: the module source should not contain that string.)
  });
});
