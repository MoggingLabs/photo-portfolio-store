import { createHash } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { authEnv } from './env.js';
import { parseTtlToSeconds } from './jwt.js';

const { sessions } = schema.users;

export interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export const sha256 = (input: string): string => {
  return createHash('sha256').update(input, 'utf8').digest('hex');
};

export const computeRefreshExpiry = (now: Date = new Date()): Date => {
  const seconds = parseTtlToSeconds(authEnv.JWT_REFRESH_TTL);
  return new Date(now.getTime() + seconds * 1000);
};

export const createSession = async (
  db: DbClient,
  userId: string,
  refreshTokenPlain: string,
  userAgent: string | null,
  ip: string | null,
): Promise<{ id: string; expiresAt: Date }> => {
  const refreshTokenHash = sha256(refreshTokenPlain);
  const expiresAt = computeRefreshExpiry();
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      refreshTokenHash,
      userAgent: userAgent ?? null,
      ip: ip ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id, expiresAt: sessions.expiresAt });
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create session');
  }
  return { id: row.id, expiresAt: row.expiresAt };
};

export const revokeSession = async (db: DbClient, sessionId: string): Promise<void> => {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
};

export const findActiveSession = async (
  db: DbClient,
  refreshTokenPlain: string,
): Promise<SessionRow | null> => {
  const refreshTokenHash = sha256(refreshTokenPlain);
  const now = new Date();
  const rows = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.refreshTokenHash, refreshTokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};
