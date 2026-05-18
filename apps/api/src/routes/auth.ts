// Identity auth routes — register, login, refresh, logout.
//
// Mounts under /v1/auth. Exported as a Fastify plugin; wiring lives in
// server.ts (added by the operator, not this file).

import { randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { schema } from '@pkg/db';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authEnv } from '../auth/env.js';
import { signAccess, signRefresh } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  computeRefreshExpiry,
  createSession,
  findActiveSession,
  revokeSession,
} from '../auth/tokens.js';
import { hashIp, writeAudit } from '../lib/audit.js';
import { db } from '../lib/db.js';

const { users } = schema.users;

const REFRESH_COOKIE = 'refresh_token';

// Minimal common-password denylist. Full pwned-passwords integration arrives
// in a later feature.
const COMMON_PASSWORDS = new Set([
  'password',
  'password123',
  'qwerty',
  'qwerty123',
  '123456789012',
  '111111111111',
  'letmein12345',
  'iloveyou1234',
  'admin1234567',
  'welcome12345',
]);

const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(256)
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'password is too common');

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: passwordSchema,
  displayName: z.string().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

const refreshSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .optional();

const logoutSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .optional();

const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

const generateRefreshToken = (): string => randomBytes(32).toString('hex');

const getClientIp = (req: FastifyRequest): string => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? req.ip;
  }
  return req.ip;
};

const getRefreshTokenFromRequest = (
  req: FastifyRequest,
  bodyToken: string | undefined,
): string | undefined => {
  if (bodyToken) return bodyToken;
  // Best-effort cookie parse without depending on @fastify/cookie.
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === REFRESH_COOKIE) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
};

const setRefreshCookie = (reply: FastifyReply, token: string, expiresAt: Date): void => {
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  reply.header('set-cookie', parts.join('; '));
};

const clearRefreshCookie = (reply: FastifyReply): void => {
  const parts = [
    `${REFRESH_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  reply.header('set-cookie', parts.join('; '));
};

// Decoy hash used so login() always pays the argon2 cost even when the
// email lookup misses. Generated once per process to avoid per-request cost.
let decoyHashPromise: Promise<string> | null = null;
const getDecoyHash = (): Promise<string> => {
  decoyHashPromise ??= hashPassword(randomBytes(24).toString('hex'));
  return decoyHashPromise;
};

const authRoutes = async (app: FastifyInstance): Promise<void> => {
  await app.register(rateLimit, {
    max: authEnv.RATE_LIMIT_AUTH_REQS_PER_MIN,
    timeWindow: '1 minute',
    keyGenerator: (req) => getClientIp(req),
    allowList: () => false,
  });

  // ---------- POST /v1/auth/register ----------
  app.post('/v1/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const email = normalizeEmail(parsed.data.email);
    const ipHash = hashIp(getClientIp(req));
    const userAgent = req.headers['user-agent'] ?? undefined;

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(drizzleSql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing.length > 0) {
      await writeAudit(db, {
        action: 'auth.register.failed',
        actorKind: 'system',
        ipHash,
        userAgent,
        payload: { reason: 'duplicate_email' },
      });
      return reply.code(409).send({ error: 'email_in_use' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const inserted = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        displayName: parsed.data.displayName ?? null,
      })
      .returning({
        id: users.id,
        email: users.email,
        role: users.role,
      });
    const user = inserted[0];
    if (!user) {
      return reply.code(500).send({ error: 'register_failed' });
    }
    await writeAudit(db, {
      action: 'auth.register',
      actorKind: 'user',
      actorUserId: user.id,
      targetKind: 'user',
      targetId: user.id,
      ipHash,
      userAgent,
    });
    return reply.code(201).send({ user });
  });

  // ---------- POST /v1/auth/login ----------
  app.post('/v1/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const email = normalizeEmail(parsed.data.email);
    const ipHash = hashIp(getClientIp(req));
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] ?? undefined;

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        passwordHash: users.passwordHash,
        status: users.status,
      })
      .from(users)
      .where(drizzleSql`lower(${users.email}) = ${email}`)
      .limit(1);
    const user = rows[0];

    // Constant-time: always run verify (decoy when user not found / no hash).
    const hashToCheck = user?.passwordHash ?? (await getDecoyHash());
    const passwordOk = await verifyPassword(parsed.data.password, hashToCheck);

    if (!user || !user.passwordHash || !passwordOk || user.status !== 'active') {
      await writeAudit(db, {
        action: 'auth.login.failed',
        actorKind: 'system',
        actorUserId: user?.id,
        ipHash,
        userAgent,
        payload: { reason: !user ? 'unknown_email' : 'bad_credentials' },
      });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const refreshTokenPlain = generateRefreshToken();
    const session = await createSession(db, user.id, refreshTokenPlain, userAgent ?? null, ip);
    const accessToken = signAccess({ sub: user.id, role: user.role });
    const refreshToken = signRefresh({ sub: user.id, sid: session.id });

    // Store the opaque plaintext + JWT envelope: we expose the JWT to the
    // client but persist the opaque random portion's hash. The cookie carries
    // the opaque token so server-side lookup is by sha256.
    // NOTE: createSession stored sha256(refreshTokenPlain). The cookie/body
    // value returned to the client is refreshTokenPlain.
    setRefreshCookie(reply, refreshTokenPlain, session.expiresAt);

    await writeAudit(db, {
      action: 'auth.login',
      actorKind: 'user',
      actorUserId: user.id,
      targetKind: 'session',
      targetId: session.id,
      ipHash,
      userAgent,
    });

    return reply.code(200).send({
      accessToken,
      refreshToken: refreshTokenPlain,
      // jwt envelope retained for clients that prefer signed refresh tokens.
      refreshTokenJwt: refreshToken,
      user: { id: user.id, email: user.email, role: user.role },
    });
  });

  // ---------- POST /v1/auth/refresh ----------
  app.post('/v1/auth/refresh', async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body ?? {});
    const bodyToken = parsed.success ? parsed.data?.refreshToken : undefined;
    const token = getRefreshTokenFromRequest(req, bodyToken);
    const ipHash = hashIp(getClientIp(req));
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] ?? undefined;

    if (!token) {
      await writeAudit(db, {
        action: 'auth.refresh.failed',
        actorKind: 'system',
        ipHash,
        userAgent,
        payload: { reason: 'missing_token' },
      });
      return reply.code(401).send({ error: 'invalid_refresh_token' });
    }

    const session = await findActiveSession(db, token);
    if (!session) {
      await writeAudit(db, {
        action: 'auth.refresh.failed',
        actorKind: 'system',
        ipHash,
        userAgent,
        payload: { reason: 'no_active_session' },
      });
      return reply.code(401).send({ error: 'invalid_refresh_token' });
    }

    const userRows = await db
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || user.status !== 'active') {
      await revokeSession(db, session.id);
      await writeAudit(db, {
        action: 'auth.refresh.failed',
        actorKind: 'system',
        actorUserId: session.userId,
        ipHash,
        userAgent,
        payload: { reason: 'user_inactive' },
      });
      return reply.code(401).send({ error: 'invalid_refresh_token' });
    }

    // Rotate: revoke old session, mint a new one.
    await revokeSession(db, session.id);
    const newRefreshPlain = generateRefreshToken();
    const newSession = await createSession(db, user.id, newRefreshPlain, userAgent ?? null, ip);
    const accessToken = signAccess({ sub: user.id, role: user.role });
    const refreshTokenJwt = signRefresh({ sub: user.id, sid: newSession.id });
    setRefreshCookie(reply, newRefreshPlain, newSession.expiresAt);

    await writeAudit(db, {
      action: 'auth.refresh',
      actorKind: 'user',
      actorUserId: user.id,
      targetKind: 'session',
      targetId: newSession.id,
      ipHash,
      userAgent,
      payload: { rotatedFrom: session.id },
    });

    return reply.code(200).send({
      accessToken,
      refreshToken: newRefreshPlain,
      refreshTokenJwt,
    });
  });

  // ---------- POST /v1/auth/logout ----------
  app.post('/v1/auth/logout', async (req, reply) => {
    const parsed = logoutSchema.safeParse(req.body ?? {});
    const bodyToken = parsed.success ? parsed.data?.refreshToken : undefined;
    const token = getRefreshTokenFromRequest(req, bodyToken);
    const ipHash = hashIp(getClientIp(req));
    const userAgent = req.headers['user-agent'] ?? undefined;

    if (token) {
      const session = await findActiveSession(db, token);
      if (session) {
        await revokeSession(db, session.id);
        await writeAudit(db, {
          action: 'auth.logout',
          actorKind: 'user',
          actorUserId: session.userId,
          targetKind: 'session',
          targetId: session.id,
          ipHash,
          userAgent,
        });
      }
    }
    clearRefreshCookie(reply);
    return reply.code(204).send();
  });

  // Silence unused-import warning when computeRefreshExpiry is needed
  // externally; reference it here so tree-shakers keep it.
  void computeRefreshExpiry;
};

export default authRoutes;
