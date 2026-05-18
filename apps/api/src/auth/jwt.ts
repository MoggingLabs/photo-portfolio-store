import jwt from 'jsonwebtoken';
import { authEnv } from './env.js';

export interface AccessTokenPayload {
  sub: string;
  role: string;
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
}

/**
 * Parse simple TTL strings like '15m', '30d', '24h', '60s', or a raw seconds
 * integer. Returns seconds. Throws on invalid input.
 */
export const parseTtlToSeconds = (ttl: string): number => {
  const match = /^(\d+)([smhd])?$/.exec(ttl.trim());
  if (!match) {
    throw new Error(`Invalid TTL string: ${ttl}`);
  }
  const value = Number.parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 's';
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 60 * 60 * 24,
  };
  const mul = multipliers[unit];
  if (mul === undefined) {
    throw new Error(`Invalid TTL unit: ${unit}`);
  }
  return value * mul;
};

export const signAccess = (payload: AccessTokenPayload): string => {
  const expiresIn = parseTtlToSeconds(authEnv.JWT_ACCESS_TTL);
  return jwt.sign(payload, authEnv.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn,
  });
};

export const signRefresh = (payload: RefreshTokenPayload): string => {
  const expiresIn = parseTtlToSeconds(authEnv.JWT_REFRESH_TTL);
  return jwt.sign(payload, authEnv.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn,
  });
};

const isAccessPayload = (value: unknown): value is AccessTokenPayload => {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.sub === 'string' && typeof obj.role === 'string';
};

const isRefreshPayload = (value: unknown): value is RefreshTokenPayload => {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.sub === 'string' && typeof obj.sid === 'string';
};

export const verifyAccess = (token: string): AccessTokenPayload | null => {
  try {
    const decoded = jwt.verify(token, authEnv.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    });
    if (!isAccessPayload(decoded)) return null;
    return { sub: decoded.sub, role: decoded.role };
  } catch {
    return null;
  }
};

export const verifyRefresh = (token: string): RefreshTokenPayload | null => {
  try {
    const decoded = jwt.verify(token, authEnv.JWT_REFRESH_SECRET, {
      algorithms: ['HS256'],
    });
    if (!isRefreshPayload(decoded)) return null;
    return { sub: decoded.sub, sid: decoded.sid };
  } catch {
    return null;
  }
};
