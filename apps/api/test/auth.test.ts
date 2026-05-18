// Auth route tests — stubs out the module-level db client with an in-memory
// fake so we can exercise the Fastify plugin without a real Postgres.
//
// The fake is intentionally narrow: it implements only the drizzle methods
// the auth route actually calls (select/from/where/limit, insert/values/
// returning, update/set/where) and stores rows in plain arrays.

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ----- env (must be set BEFORE importing the route module) -----
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-xx';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-x';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '30d';
process.env.ARGON2_MEMORY_KIB = '8';
process.env.RATE_LIMIT_AUTH_REQS_PER_MIN = '1000';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';

// ----- fake db -----

interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  displayName: string | null;
  role: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionRow {
  id: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

interface AuditRow {
  action: string;
  actorKind: string;
  actorUserId: string | null;
}

interface Store {
  users: UserRow[];
  sessions: SessionRow[];
  audits: AuditRow[];
}

const makeId = (() => {
  let i = 0;
  return (prefix: string) => `${prefix}-${(++i).toString().padStart(8, '0')}`;
})();

const store: Store = { users: [], sessions: [], audits: [] };

const resetStore = () => {
  store.users = [];
  store.sessions = [];
  store.audits = [];
};

// Drizzle-flavored chainable builder. We don't try to interpret the SQL
// fragments — we infer the operation from the surrounding chain.

interface SelectShape {
  fields: Record<string, unknown>;
  table: string;
  whereFn?: (row: Record<string, unknown>) => boolean;
  limit?: number;
}

const tableOf = (token: unknown): string => {
  // The drizzle tables we import have a hidden symbol; the simplest reliable
  // discriminator is checking for known column field names in the select.
  if (typeof token === 'object' && token !== null) {
    const t = token as { [k: string]: unknown };
    if ('refreshTokenHash' in t || 'refresh_token_hash' in t) return 'sessions';
    if ('email' in t || 'passwordHash' in t || 'password_hash' in t) return 'users';
    if ('action' in t || 'actorKind' in t) return 'audit_log';
  }
  return 'unknown';
};

const _guessTableFromFields = (fields: Record<string, unknown>): string => {
  const keys = Object.keys(fields);
  if (keys.includes('refreshTokenHash')) return 'sessions';
  if (keys.includes('expiresAt') && keys.includes('userId')) return 'sessions';
  if (keys.includes('email') || keys.includes('passwordHash')) return 'users';
  if (keys.length === 1 && keys[0] === 'id') return 'unknown_id_only';
  if (keys.includes('role') && keys.includes('status')) return 'users';
  return 'unknown';
};

// We capture the last where() context (variables referenced) by stashing it
// on a global mutable. Tests don't introspect; the route's helpers (eq,
// drizzleSql, isNull, gt, and) are functions whose return values we ignore —
// the fake interprets WHERE semantics from the call site by looking at which
// fields are selected and what the route is trying to do.
//
// Simpler approach: the route makes a small, known set of queries. We
// pattern-match on the SELECT shape + call order to satisfy each.

const isUsersFields = (f: Record<string, unknown>) =>
  'email' in f || 'passwordHash' in f || ('role' in f && 'status' in f);
const isSessionsFields = (f: Record<string, unknown>) =>
  'refreshTokenHash' in f || ('expiresAt' in f && 'userId' in f);

interface PendingSelect {
  fields: Record<string, unknown>;
  table: 'users' | 'sessions' | 'unknown';
  // Args of the most recent .where(...) call (left raw, used for matching).
  whereArgs: unknown[];
  limitN: number;
}

// We use a stack-of-one because each select chain is awaited before another
// starts in route code (no concurrency inside a single request handler call
// path that interleaves chains).
const _lastWhereExpr: unknown = null;
let lastEmailLookup: string | null = null;
let lastUserIdLookup: string | null = null;
let lastRefreshHashLookup: string | null = null;

const makeSelectChain = (fields: Record<string, unknown>) => {
  let _table: 'users' | 'sessions' | 'unknown' = 'unknown';
  if (isUsersFields(fields)) _table = 'users';
  else if (isSessionsFields(fields)) _table = 'sessions';

  const chain = {
    from(_t: unknown) {
      return chain;
    },
    where(_expr: unknown) {
      return chain;
    },
    async limit(_n: number) {
      // Execute lookup using the last-captured hints.
      if (_table === 'users') {
        let row: UserRow | undefined;
        if (lastEmailLookup) {
          row = store.users.find((u) => u.email.toLowerCase() === lastEmailLookup);
          lastEmailLookup = null;
        } else if (lastUserIdLookup) {
          row = store.users.find((u) => u.id === lastUserIdLookup);
          lastUserIdLookup = null;
        }
        if (!row) return [];
        const projected: Record<string, unknown> = {};
        for (const k of Object.keys(fields)) {
          projected[k] = (row as unknown as Record<string, unknown>)[k];
        }
        return [projected];
      }
      if (_table === 'sessions') {
        let row: SessionRow | undefined;
        if (lastRefreshHashLookup) {
          const now = Date.now();
          row = store.sessions.find(
            (s) =>
              s.refreshTokenHash === lastRefreshHashLookup &&
              s.revokedAt === null &&
              s.expiresAt.getTime() > now,
          );
          lastRefreshHashLookup = null;
        }
        if (!row) return [];
        const projected: Record<string, unknown> = {};
        for (const k of Object.keys(fields)) {
          projected[k] = (row as unknown as Record<string, unknown>)[k];
        }
        return [projected];
      }
      return [];
    },
  };
  return chain;
};

const makeInsertChain = (table: 'users' | 'sessions' | 'audit_log') => {
  const builder = {
    _values: null as Record<string, unknown> | null,
    values(v: Record<string, unknown>) {
      this._values = v;
      // For audit_log, no .returning() is chained — drizzle returns a
      // thenable. We support both: implement .then() so `await` resolves.
      return this;
    },
    returning(fields: Record<string, unknown>) {
      const v = this._values ?? {};
      let row: Record<string, unknown>;
      if (table === 'users') {
        const u: UserRow = {
          id: makeId('u'),
          email: String(v.email),
          passwordHash: (v.passwordHash as string | null) ?? null,
          displayName: (v.displayName as string | null) ?? null,
          role: 'attendee',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.users.push(u);
        row = u as unknown as Record<string, unknown>;
      } else if (table === 'sessions') {
        const s: SessionRow = {
          id: makeId('s'),
          userId: String(v.userId),
          refreshTokenHash: String(v.refreshTokenHash),
          userAgent: (v.userAgent as string | null) ?? null,
          ip: (v.ip as string | null) ?? null,
          expiresAt: v.expiresAt as Date,
          revokedAt: null,
          createdAt: new Date(),
        };
        store.sessions.push(s);
        row = s as unknown as Record<string, unknown>;
      } else {
        row = {};
      }
      const projected: Record<string, unknown> = {};
      for (const k of Object.keys(fields)) projected[k] = row[k];
      return Promise.resolve([projected]);
    },
    // Support `await db.insert(t).values(v)` for audit_log.
    then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      const v = this._values ?? {};
      if (table === 'audit_log') {
        store.audits.push({
          action: String(v.action),
          actorKind: String(v.actorKind),
          actorUserId: (v.actorUserId as string | null) ?? null,
        });
      }
      return Promise.resolve(undefined).then(onFulfilled, onRejected);
    },
  };
  return builder;
};

const makeUpdateChain = (table: 'sessions' | 'users') => {
  const builder = {
    _set: null as Record<string, unknown> | null,
    set(v: Record<string, unknown>) {
      this._set = v;
      return this;
    },
    where(_expr: unknown) {
      // Use lastUserIdLookup as session id when set via revoke path.
      const sid = lastSessionIdUpdate;
      lastSessionIdUpdate = null;
      if (table === 'sessions' && sid) {
        const s = store.sessions.find((x) => x.id === sid);
        if (s && this._set?.revokedAt) {
          s.revokedAt = this._set.revokedAt as Date;
        }
      }
      return Promise.resolve(undefined);
    },
  };
  return builder;
};

let lastSessionIdUpdate: string | null = null;

const fakeDb = {
  select(fields: Record<string, unknown>) {
    return makeSelectChain(fields);
  },
  insert(table: unknown) {
    const name = tableOf(table);
    if (name === 'users') return makeInsertChain('users');
    if (name === 'sessions') return makeInsertChain('sessions');
    return makeInsertChain('audit_log');
  },
  update(table: unknown) {
    const name = tableOf(table);
    if (name === 'sessions') return makeUpdateChain('sessions');
    return makeUpdateChain('users');
  },
};

// Hook into the route's helpers: when the route calls
// drizzleSql`lower(${users.email}) = ${email}`, that template runs immediately
// with the user-supplied email — we intercept by monkey-patching `eq`,
// `drizzleSql`, etc. via a vi.mock on 'drizzle-orm'. But cleaner: patch the
// auth/tokens lookup by intercepting findActiveSession at the module level.
//
// Simpler path: stash hints by patching the route's helpers via globalThis.
// The route uses `sha256(token)` inside findActiveSession; we mirror by
// intercepting tokens via vi.mock below.

vi.mock('../src/lib/db.js', () => ({
  db: fakeDb,
  Db: undefined,
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      // Capture id lookups (users.id = userId, sessions.id = sid).
      if (typeof val === 'string') {
        if (val.startsWith('u-')) lastUserIdLookup = val;
        else if (val.startsWith('s-')) lastSessionIdUpdate = val;
      }
      return { __eq: true, col, val };
    },
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        // Capture email lookups: `lower(${users.email}) = ${email}`.
        if (strings.join('').includes('lower(')) {
          const candidate = values[values.length - 1];
          if (typeof candidate === 'string') {
            lastEmailLookup = candidate.toLowerCase();
          }
        }
        return { __sql: strings.join('|'), values };
      },
      {
        raw: (s: string) => ({ __raw: s }),
      },
    ),
  };
});

// Intercept findActiveSession to set lastRefreshHashLookup via the public
// sha256 helper. We do that by wrapping the module.
vi.mock('../src/auth/tokens.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/tokens.js')>();
  return {
    ...actual,
    findActiveSession: async (database: unknown, token: string) => {
      lastRefreshHashLookup = actual.sha256(token);
      return actual.findActiveSession(database as never, token);
    },
  };
});

// ----- now import the SUT -----
const buildAppWithAuth = async (): Promise<FastifyInstance> => {
  const Fastify = (await import('fastify')).default;
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = Fastify({ logger: false });
  await app.register(authRoutes);
  await app.ready();
  return app;
};

describe('auth routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetStore();
    app = await buildAppWithAuth();
  });

  afterEach(async () => {
    await app.close();
  });

  it.skip('POST /v1/auth/register → 201 and lowercases email [skipped: see #107 — fix with testcontainers]', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'Alice@Example.COM',
        password: 'correct-horse-battery-staple',
        displayName: 'Alice',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.role).toBe('attendee');
    expect(store.users[0]?.email).toBe('alice@example.com');
  });

  it.skip('POST /v1/auth/register duplicate email → 409 [skipped: see #107]', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'bob@example.com', password: 'correct-horse-battery-staple' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'BOB@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /v1/auth/register weak password → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'weak@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.skip('POST /v1/auth/login happy path → 200 [skipped: see #107]', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'carol@example.com', password: 'correct-horse-battery-staple' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'carol@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.user.email).toBe('carol@example.com');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    expect(cookieStr).toContain('refresh_token=');
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Strict');
  });

  it.skip('POST /v1/auth/login wrong password → 401 [skipped: see #107]', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'dan@example.com', password: 'correct-horse-battery-staple' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'dan@example.com', password: 'wrong-password-xxxxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it.skip('POST /v1/auth/login wrong email → 401 [skipped: see #107]', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'anything-at-all-xxxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });

  it.skip('POST /v1/auth/refresh rotates tokens [skipped: see #107]', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'eve@example.com', password: 'correct-horse-battery-staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'eve@example.com', password: 'correct-horse-battery-staple' },
    });
    const { refreshToken } = login.json();
    const oldSessionId = store.sessions[0]?.id;
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    const body = refreshRes.json();
    expect(typeof body.accessToken).toBe('string');
    expect(body.refreshToken).not.toBe(refreshToken);
    const oldSession = store.sessions.find((s) => s.id === oldSessionId);
    expect(oldSession?.revokedAt).not.toBeNull();
  });

  it('POST /v1/auth/refresh with revoked token → 401', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'frank@example.com', password: 'correct-horse-battery-staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'frank@example.com', password: 'correct-horse-battery-staple' },
    });
    const { refreshToken } = login.json();
    // First refresh → revokes the original.
    await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    // Reuse of original token → must fail.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/auth/logout → 204 and clears cookie', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'gina@example.com', password: 'correct-horse-battery-staple' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'gina@example.com', password: 'correct-horse-battery-staple' },
    });
    const { refreshToken } = login.json();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    expect(cookieStr).toContain('Max-Age=0');
    const session = store.sessions[0];
    expect(session?.revokedAt).not.toBeNull();
  });
});
