// Resumable multipart upload service tests (F1.11).
//
// The S3 client is mocked via aws-sdk-client-mock. The Drizzle DbClient is
// replaced with a hand-rolled fake that records inserts/updates and feeds
// back canned rows on select, so these tests run without a live Postgres.

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { DbClient } from '@pkg/db';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Storage env must be present before the storage module is imported.
process.env.S3_REGION ??= 'auto';
process.env.S3_ACCESS_KEY_ID ??= 'test-access-key';
process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret-key';
process.env.S3_BUCKET_ORIGINALS ??= 'originals-test';
process.env.S3_BUCKET_DERIVATIVES ??= 'derivatives-test';
process.env.S3_PUBLIC_BASE_URL ??= 'https://cdn.example.test';

const s3Mock = mockClient(S3Client);

// ---------- Fake DbClient ----------
//
// We only need a handful of Drizzle builder shapes:
//   - insert(table).values(...).returning(...)
//   - update(table).set(...).where(...)
//   - select().from(table).where(...).limit(...)
//
// We keep an in-memory store of upload_sessions, photos, and audit rows, plus
// a way for tests to seed sessions directly without going through initUpload.

type Row = Record<string, unknown>;

interface FakeStore {
  uploadSessions: Map<string, Row>;
  photos: Row[];
  auditRows: Row[];
}

const makeStore = (): FakeStore => ({
  uploadSessions: new Map(),
  photos: [],
  auditRows: [],
});

let store: FakeStore;

const tableKey = (table: unknown): 'uploadSessions' | 'photos' | 'auditLog' => {
  const sym = Object.getOwnPropertySymbols(table as object).find(
    (s) => s.description === 'drizzle:Name',
  );
  const name = sym ? ((table as Record<symbol, unknown>)[sym] as string) : '';
  if (name === 'upload_sessions') return 'uploadSessions';
  if (name === 'photos') return 'photos';
  if (name === 'audit_log') return 'auditLog';
  throw new Error(`Unknown table in fake DbClient: ${name}`);
};

const randomId = (): string => {
  const hex = (n: number) =>
    Math.floor(Math.random() * 16 ** n)
      .toString(16)
      .padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
};

const makeFakeDb = (): DbClient => {
  const fake = {
    insert(table: unknown) {
      const which = tableKey(table);
      return {
        values(value: Row | Row[]) {
          const values = Array.isArray(value) ? value : [value];
          const inserted = values.map((v) => ({ ...v, id: (v.id as string) ?? randomId() }));
          if (which === 'uploadSessions') {
            for (const row of inserted) {
              store.uploadSessions.set(row.id as string, row);
            }
          } else if (which === 'photos') {
            store.photos.push(...inserted);
          } else {
            store.auditRows.push(...inserted);
          }
          const builder = {
            returning(_cols?: unknown) {
              return Promise.resolve(inserted.map((r) => ({ id: r.id })));
            },
            then(resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) {
              return Promise.resolve(inserted).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
    update(table: unknown) {
      const which = tableKey(table);
      return {
        set(patch: Row) {
          return {
            where(_cond: unknown) {
              if (which === 'uploadSessions') {
                // The tests only ever update one specific session; apply patch
                // to every session row (the where clauses target by id).
                for (const [id, row] of store.uploadSessions.entries()) {
                  store.uploadSessions.set(id, { ...row, ...patch });
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          const which = tableKey(table);
          return {
            where(_cond: unknown) {
              return {
                limit(_n: number) {
                  if (which === 'uploadSessions') {
                    const first = store.uploadSessions.values().next().value as Row | undefined;
                    return Promise.resolve(first ? [first] : []);
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  };
  return fake as unknown as DbClient;
};

// Lazy-loaded after env is set above.
let uploads: typeof import('../src/services/uploads.js');

beforeAll(async () => {
  uploads = await import('../src/services/uploads.js');
});

beforeEach(() => {
  store = makeStore();
  s3Mock.reset();
});

const eventId = '11111111-1111-4111-8111-111111111111';
const photographerUserId = '22222222-2222-4222-8222-222222222222';

const seedSession = (overrides: Partial<Row> = {}): string => {
  const id = (overrides.id as string) ?? randomId();
  store.uploadSessions.set(id, {
    id,
    eventId,
    photographerUserId,
    originalFilename: 'photo.jpg',
    contentType: 'image/jpeg',
    totalBytes: BigInt(20 * 1024 * 1024),
    r2UploadId: 'upload-id-seed',
    r2ObjectKey: `originals/${eventId}/seed.jpg`,
    chunkSizeBytes: 8 * 1024 * 1024,
    status: 'in_progress',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    chunksReceived: 0,
    ...overrides,
  });
  return id;
};

describe('initUpload', () => {
  it('happy path returns sessionId, uploadId and totalChunks', async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'mp-upload-1' });

    const db = makeFakeDb();
    const result = await uploads.initUpload(db, eventId, photographerUserId, {
      filename: 'sunset.jpg',
      contentType: 'image/jpeg',
      totalBytes: 16 * 1024 * 1024,
      chunkSize: 8 * 1024 * 1024,
    });

    expect(result.uploadId).toBe('mp-upload-1');
    expect(result.key.startsWith(`originals/${eventId}/`)).toBe(true);
    expect(result.key.endsWith('.jpg')).toBe(true);
    expect(result.chunkSize).toBe(8 * 1024 * 1024);
    expect(result.totalChunks).toBe(2);
    expect(store.uploadSessions.size).toBe(1);
    expect(store.auditRows.some((r) => r.action === 'media.upload.init')).toBe(true);
  });

  it('rejects non-image contentType', async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'mp-upload-x' });
    const db = makeFakeDb();
    await expect(
      uploads.initUpload(db, eventId, photographerUserId, {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        totalBytes: 1024,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects totalBytes greater than 50 MiB', async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'mp-upload-x' });
    const db = makeFakeDb();
    await expect(
      uploads.initUpload(db, eventId, photographerUserId, {
        filename: 'huge.jpg',
        contentType: 'image/jpeg',
        totalBytes: 60 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('presignChunk', () => {
  it('returns a presigned URL for an in-progress session', async () => {
    const sessionId = seedSession();
    const db = makeFakeDb();

    const result = await uploads.presignChunk(db, sessionId, 1);
    expect(result.partNumber).toBe(1);
    expect(result.uploadUrl).toMatch(/^https?:\/\//);
  });

  it('returns 410 Gone for an aborted session', async () => {
    const sessionId = seedSession({ status: 'aborted' });
    const db = makeFakeDb();
    await expect(uploads.presignChunk(db, sessionId, 1)).rejects.toMatchObject({
      statusCode: 410,
    });
  });
});

describe('completeUpload', () => {
  it('rejects with 400 when parts are not contiguous starting at 1', async () => {
    const sessionId = seedSession();
    const db = makeFakeDb();

    await expect(
      uploads.completeUpload(db, sessionId, {
        parts: [
          { partNumber: 1, etag: 'aaa' },
          { partNumber: 3, etag: 'ccc' },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('happy path completes upload and inserts a photos row in processing', async () => {
    const sessionId = seedSession();
    const db = makeFakeDb();

    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: 'final-etag' });

    const result = await uploads.completeUpload(db, sessionId, {
      parts: [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 3, etag: 'etag-3' },
      ],
    });

    expect(result.status).toBe('processing');
    expect(result.photoId).toMatch(/[0-9a-f-]{36}/);
    expect(store.photos.length).toBe(1);
    expect(store.photos[0]?.status).toBe('processing');
    expect(store.auditRows.some((r) => r.action === 'media.upload.completed')).toBe(true);

    const completeCalls = s3Mock.commandCalls(CompleteMultipartUploadCommand);
    expect(completeCalls.length).toBe(1);
  });
});

describe('abortUpload', () => {
  it('aborts an in-progress session and writes an audit row', async () => {
    const sessionId = seedSession();
    const db = makeFakeDb();

    s3Mock.on(AbortMultipartUploadCommand).resolves({});

    await uploads.abortUpload(db, sessionId);

    const calls = s3Mock.commandCalls(AbortMultipartUploadCommand);
    expect(calls.length).toBe(1);
    expect(store.uploadSessions.get(sessionId)?.status).toBe('aborted');
    expect(store.auditRows.some((r) => r.action === 'media.upload.aborted')).toBe(true);
  });
});

// Touch UploadPartCommand to keep tree-shaking happy in some setups.
void UploadPartCommand;
