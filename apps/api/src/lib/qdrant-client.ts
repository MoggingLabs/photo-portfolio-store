// F1.24 — Qdrant client for the API layer.
//
// Mirrors apps/worker/src/lib/qdrant.ts: a lazy Proxy + collectionName()
// helper. The worker has its own copy because it is a separate process; we
// duplicate the small surface here rather than introduce a shared package
// just for this. Keep both files in sync when the naming convention or
// connection shape changes.

import { QdrantClient } from '@qdrant/js-client-rest';

const FACE_COLLECTION_PREFIX = 'faces_event_';

export const collectionName = (eventId: string): string => `${FACE_COLLECTION_PREFIX}${eventId}`;

let cached: QdrantClient | undefined;

const getQdrant = (): QdrantClient => {
  if (cached) return cached;
  const url = process.env.QDRANT_URL;
  if (!url) throw new Error('QDRANT_URL is not configured');
  const apiKey = process.env.QDRANT_API_KEY || undefined;
  cached = new QdrantClient({ url, apiKey });
  return cached;
};

export const qdrant = new Proxy({} as QdrantClient, {
  get(_target, prop) {
    const real = getQdrant() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
}) as QdrantClient;

export interface SearchFacesOptions {
  limit: number;
  threshold: number;
}

export interface QdrantSearchHit {
  id: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
}

/**
 * Cosine-similarity nearest-neighbour search within an event's face
 * collection. Returns at most `limit` hits with score >= `threshold`. If the
 * collection does not exist (event has no face vectors yet), returns []
 * rather than throwing — the caller should not need to special-case empty
 * events.
 */
export const searchFaces = async (
  eventId: string,
  vector: number[],
  opts: SearchFacesOptions,
  client: QdrantClient = qdrant,
): Promise<QdrantSearchHit[]> => {
  const name = collectionName(eventId);
  try {
    const hits = await client.search(name, {
      vector,
      limit: opts.limit,
      score_threshold: opts.threshold,
      with_payload: true,
    });
    return hits.map((h) => ({
      id: h.id as string | number,
      score: h.score,
      payload: (h.payload as Record<string, unknown> | null | undefined) ?? null,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Qdrant returns 404 when a collection does not exist. We treat that as
    // "no matches" — never as a search failure.
    if (/not\s*found/i.test(message) || /doesn't exist/i.test(message)) return [];
    throw err;
  }
};
