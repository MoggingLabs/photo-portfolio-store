// F1.21 — Qdrant helper tests. Pure unit: no live Qdrant required, the
// client is injected.

import { describe, expect, it, vi } from 'vitest';

import {
  collectionName,
  dropCollection,
  ensureCollection,
  eventIdFromCollectionName,
  upsertFaceVectors,
} from '../src/lib/qdrant.js';

const eventId = '22222222-2222-2222-2222-222222222222';

describe('collectionName / eventIdFromCollectionName', () => {
  it('is deterministic for a given eventId', () => {
    expect(collectionName(eventId)).toBe(`faces_event_${eventId}`);
    expect(collectionName(eventId)).toBe(collectionName(eventId));
  });

  it('round-trips through eventIdFromCollectionName', () => {
    const name = collectionName(eventId);
    expect(eventIdFromCollectionName(name)).toBe(eventId);
  });

  it('returns null for non-face collections', () => {
    expect(eventIdFromCollectionName('bibs_event_xyz')).toBeNull();
    expect(eventIdFromCollectionName('faces_event_not-a-uuid')).toBeNull();
    expect(eventIdFromCollectionName('')).toBeNull();
  });
});

describe('ensureCollection', () => {
  it('creates the collection when it does not yet exist', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
      createCollection: vi.fn().mockResolvedValue(undefined),
    };

    await ensureCollection(eventId, 512, { client: client as never });

    expect(client.createCollection).toHaveBeenCalledTimes(1);
    expect(client.createCollection).toHaveBeenCalledWith(
      `faces_event_${eventId}`,
      expect.objectContaining({
        vectors: { size: 512, distance: 'Cosine' },
      }),
    );
  });

  it('is idempotent when the collection already exists', async () => {
    const client = {
      getCollections: vi
        .fn()
        .mockResolvedValue({ collections: [{ name: `faces_event_${eventId}` }] }),
      createCollection: vi.fn(),
    };

    await ensureCollection(eventId, 512, { client: client as never });

    expect(client.createCollection).not.toHaveBeenCalled();
  });

  it('honours a non-default embedding dim', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
      createCollection: vi.fn().mockResolvedValue(undefined),
    };

    await ensureCollection(eventId, 384, { client: client as never });

    expect(client.createCollection).toHaveBeenCalledWith(
      `faces_event_${eventId}`,
      expect.objectContaining({ vectors: { size: 384, distance: 'Cosine' } }),
    );
  });
});

describe('dropCollection', () => {
  it('calls deleteCollection with the per-event name', async () => {
    const client = { deleteCollection: vi.fn().mockResolvedValue(undefined) };
    await dropCollection(eventId, { client: client as never });
    expect(client.deleteCollection).toHaveBeenCalledWith(`faces_event_${eventId}`);
  });
});

describe('upsertFaceVectors', () => {
  it('upserts the points to the per-event collection', async () => {
    const client = { upsert: vi.fn().mockResolvedValue(undefined) };
    const points = [
      { id: 'a', vector: [0.1, 0.2], payload: { photo_id: 'p1' } },
      { id: 'b', vector: [0.3, 0.4], payload: { photo_id: 'p2' } },
    ];
    await upsertFaceVectors(eventId, points, { client: client as never });
    expect(client.upsert).toHaveBeenCalledWith(`faces_event_${eventId}`, { points });
  });

  it('no-ops on an empty points array', async () => {
    const client = { upsert: vi.fn() };
    await upsertFaceVectors(eventId, [], { client: client as never });
    expect(client.upsert).not.toHaveBeenCalled();
  });
});
