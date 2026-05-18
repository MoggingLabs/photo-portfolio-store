// Base64-encoded cursor helpers for keyset pagination.
//
// Cursors encode `{ id, createdAt }` so list endpoints can resume from a
// stable point without leaking offsets to clients. The payload is opaque
// from the caller's perspective; never include user-controlled data without
// validating after decode.

export interface CursorPayload {
  id: string;
  createdAt: Date;
}

export const encodeCursor = (payload: CursorPayload): string => {
  const json = JSON.stringify({
    id: payload.id,
    createdAt: payload.createdAt.toISOString(),
  });
  return Buffer.from(json, 'utf8').toString('base64url');
};

export const decodeCursor = (raw: string | undefined | null): CursorPayload | null => {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { id?: unknown; createdAt?: unknown };
    if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string') {
      return null;
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { id: parsed.id, createdAt };
  } catch {
    return null;
  }
};
