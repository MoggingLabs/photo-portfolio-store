// Lazy Qdrant client for the worker. Mirrors the lib/db.ts pattern: a Proxy
// that defers construction until first use, so tests that don't touch Qdrant
// don't need QDRANT_URL set.
//
// collectionName() centralizes per-event collection naming so the retention
// cron, the face-worker, and the search API all agree on the key shape.
//
// F1.21: each event gets its OWN collection. Per-event collections make the
// retention/takedown story trivial — a single `deleteCollection` call wipes
// every face vector for an event (see F1.35 + F3.5).

import { QdrantClient } from '@qdrant/js-client-rest';

export type QdrantLike = Pick<QdrantClient, 'deleteCollection'>;

const FACE_COLLECTION_PREFIX = 'faces_event_';

/**
 * The Qdrant collection that stores face embeddings for a single event.
 * Naming kept short and ASCII-safe: prefix + raw event uuid. Deterministic
 * and reversible — the eventId can be recovered from the collection name.
 */
export const collectionName = (eventId: string): string => `${FACE_COLLECTION_PREFIX}${eventId}`;

/**
 * Inverse of `collectionName`. Returns the eventId or `null` if the name
 * doesn't match the per-event face collection shape.
 */
export const eventIdFromCollectionName = (name: string): string | null => {
  if (!name.startsWith(FACE_COLLECTION_PREFIX)) return null;
  const candidate = name.slice(FACE_COLLECTION_PREFIX.length);
  // UUID v4: 8-4-4-4-12 hex chars with hyphens.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
    return null;
  }
  return candidate;
};

let cached: QdrantClient | undefined;

const getQdrant = (): QdrantClient => {
  if (cached) return cached;
  const url = process.env.QDRANT_URL;
  if (!url) {
    throw new Error('QDRANT_URL is not configured');
  }
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

export interface QdrantDeps {
  client?: QdrantClient;
}

/**
 * Idempotently create the per-event face collection. Cosine distance + 512-d
 * vectors match insightface buffalo_l output by default; override `dim` if a
 * different embedding model is in use.
 */
export const ensureCollection = async (
  eventId: string,
  dim = 512,
  deps: QdrantDeps = {},
): Promise<void> => {
  const client = deps.client ?? qdrant;
  const name = collectionName(eventId);
  const existing = await client.getCollections();
  if (existing.collections.find((c) => c.name === name)) return;
  await client.createCollection(name, {
    vectors: { size: dim, distance: 'Cosine' },
    optimizers_config: { default_segment_number: 2 },
    hnsw_config: { m: 16, ef_construct: 100 },
  });
};

/**
 * Drop a single event's face collection — the primitive used by retention /
 * takedown workflows to wipe biometric data for one event with one call.
 */
export const dropCollection = async (eventId: string, deps: QdrantDeps = {}): Promise<void> => {
  const client = deps.client ?? qdrant;
  await client.deleteCollection(collectionName(eventId));
};

export interface FaceVectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export const upsertFaceVectors = async (
  eventId: string,
  points: FaceVectorPoint[],
  deps: QdrantDeps = {},
): Promise<void> => {
  if (points.length === 0) return;
  const client = deps.client ?? qdrant;
  await client.upsert(collectionName(eventId), { points });
};
