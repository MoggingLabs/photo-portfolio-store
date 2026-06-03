// F4.2 — SFTP staged-upload dedup + enqueue tests (fake db + queue).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  schema: {
    sftp: {
      sftpUploads: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        contentHash: { column: 'contentHash' },
        path: { column: 'path' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => ({}));

type Row = Record<string, unknown>;
let uploads: Row[];

const makeDb = () => ({
  insert: () => ({
    values: (v: Row) => ({
      onConflictDoNothing: () => ({
        returning: () => {
          const dupe = uploads.some(
            (r) => r.eventId === v.eventId && r.contentHash === v.contentHash,
          );
          if (dupe) return Promise.resolve([]);
          const id = `u${uploads.length + 1}`;
          uploads.push({ ...v, id });
          return Promise.resolve([{ id }]);
        },
      }),
    }),
  }),
});

let job: typeof import('../src/jobs/sftp-ingest.js');

beforeEach(async () => {
  uploads = [];
  job = await import('../src/jobs/sftp-ingest.js');
});

describe('enqueueStableUploads', () => {
  it('enqueues one ingest per new (event, content hash)', async () => {
    const add = vi.fn(async () => undefined);
    const res = await job.enqueueStableUploads(
      makeDb() as never,
      [
        { eventId: 'e1', path: '/in/a.jpg', contentHash: 'h1' },
        { eventId: 'e1', path: '/in/b.jpg', contentHash: 'h2' },
      ],
      { queue: { add } as never },
    );
    expect(res.enqueued).toBe(2);
    expect(add).toHaveBeenCalledTimes(2);
    // stable job id derived from event + hash.
    expect((add.mock.calls[0] as unknown[])[2]).toMatchObject({ jobId: 'sftp:e1:h1' });
  });

  it('dedups a resumed/duplicate upload (same hash) — enqueues once', async () => {
    const add = vi.fn(async () => undefined);
    const db = makeDb();
    const same = { eventId: 'e1', path: '/in/a.jpg', contentHash: 'h1' };
    const r1 = await job.enqueueStableUploads(db as never, [same], { queue: { add } as never });
    const r2 = await job.enqueueStableUploads(db as never, [same], { queue: { add } as never });
    expect(r1.enqueued).toBe(1);
    expect(r2.enqueued).toBe(0);
    expect(r2.duplicates).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('treats the same hash under different events as distinct', async () => {
    const add = vi.fn(async () => undefined);
    const res = await job.enqueueStableUploads(
      makeDb() as never,
      [
        { eventId: 'e1', path: '/a.jpg', contentHash: 'h1' },
        { eventId: 'e2', path: '/a.jpg', contentHash: 'h1' },
      ],
      { queue: { add } as never },
    );
    expect(res.enqueued).toBe(2);
  });
});
