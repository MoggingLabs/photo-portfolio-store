// F4.4 — cloud-import sweep tests (routing fake db + stub adapter).

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const col = (column: string) => ({ column });
const cols = (...names: string[]) => Object.fromEntries(names.map((n) => [n, col(n)]));

vi.mock('@pkg/db', () => ({
  schema: {
    cloudImports: {
      cloudImports: cols(
        'id',
        'eventId',
        'orgId',
        'photographerUserId',
        'provider',
        'remoteFolderId',
        'status',
        'totalFiles',
        'importedFiles',
        'failedFiles',
        'startedAt',
        'completedAt',
        'lastError',
        'updatedAt',
      ),
      cloudImportFiles: cols(
        'id',
        'cloudImportId',
        'remoteFileId',
        'contentHash',
        'name',
        'contentType',
        'sizeBytes',
        'photoId',
        'status',
        'attempts',
        'error',
        'updatedAt',
      ),
    },
    integrations: {
      integrationConfigs: cols(
        'id',
        'orgId',
        'type',
        'enabled',
        'encryptedCredentials',
        'updatedAt',
      ),
    },
    photos: { photos: cols('id') },
  },
}));

// Keep CloudStorageError real (instanceof checks) but stub the envelope crypto.
const h = vi.hoisted(() => ({
  token: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9_999_999_999 },
}));
vi.mock('@pkg/integrations', async (orig) => {
  const actual = await orig<typeof import('@pkg/integrations')>();
  return {
    ...actual,
    decryptCredentials: () => JSON.stringify(h.token),
    encryptCredentials: () => 'enc-new',
  };
});

vi.mock('drizzle-orm', () => {
  type Col = { column: string };
  const isCol = (v: unknown): v is Col =>
    typeof v === 'object' && v !== null && 'column' in (v as Col);
  const valOf = (v: unknown, r: Record<string, unknown>) => (isCol(v) ? r[v.column] : v);
  return {
    eq: (a: unknown, b: unknown) => (r: Record<string, unknown>) => valOf(a, r) === valOf(b, r),
    and:
      (...ps: Array<(r: Record<string, unknown>) => boolean>) =>
      (r: Record<string, unknown>) =>
        ps.every((p) => p(r)),
    inArray: (a: Col, arr: unknown[]) => (r: Record<string, unknown>) => arr.includes(r[a.column]),
  };
});

import { CloudStorageError } from '@pkg/integrations';

type Row = Record<string, unknown>;
let store: Record<string, Row[]>;

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    let tn = '';
    let pred: ((r: Row) => boolean) | null = null;
    const project = (r: Row): Row => {
      const o: Row = {};
      for (const k of Object.keys(sel)) o[k] = r[sel[k]?.column ?? k];
      return o;
    };
    const run = (lim?: number) => {
      let rows = (store[tn] ?? []).slice();
      if (pred) rows = rows.filter(pred);
      if (lim != null) rows = rows.slice(0, lim);
      return rows.map(project);
    };
    const b = {
      from: (t: { __t: string }) => {
        tn = t.__t;
        return b;
      },
      where: (p: (r: Row) => boolean) => {
        pred = p;
        return b;
      },
      limit: (n: number) => Promise.resolve(run(n)),
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  const insert = (t: { __t: string }) => ({
    values: (v: Row) => ({
      onConflictDoNothing: () => {
        const rows = store[t.__t] ?? [];
        const dup = rows.some(
          (r) => r.cloudImportId === v.cloudImportId && r.contentHash === v.contentHash,
        );
        if (!dup)
          rows.push({ id: `${t.__t}-${rows.length + 1}`, attempts: 0, photoId: null, ...v });
        return Promise.resolve();
      },
      returning: () => {
        const rows = store[t.__t] ?? [];
        const id = `${t.__t}-${rows.length + 1}`;
        rows.push({ id, ...v });
        return Promise.resolve([{ id }]);
      },
    }),
  });
  const update = (t: { __t: string }) => ({
    set: (s: Row) => ({
      where: (pred: (r: Row) => boolean) => {
        for (const r of store[t.__t] ?? []) if (pred(r)) Object.assign(r, s);
        return Promise.resolve();
      },
    }),
  });
  return { select, insert, update };
};

let job: typeof import('../src/jobs/cloud-import.js');
const NOW = new Date('2026-06-01T12:00:00Z');

const deps = (over: Partial<Parameters<typeof job.runCloudImport>[1]> = {}) => ({
  masterKey: 'mk',
  adapterFactory: () => stub,
  refreshToken: vi.fn(async () => ({ ...h.token, accessToken: 'AT2' })),
  uploader: vi.fn(async () => undefined),
  ingestQueue: { add: vi.fn(async () => undefined) },
  now: () => NOW,
  ...over,
});

interface StubOpts {
  failOn?: string;
  rateLimitOn?: string;
  error?: unknown;
}
let stub: ReturnType<typeof makeStub>;
const makeStub = (files: unknown[], opts: StubOpts = {}) => ({
  provider: 'gdrive' as const,
  listFolder: async () => files,
  download: async (fileId: string) => {
    if (opts.failOn === fileId) throw opts.error;
    if (opts.rateLimitOn === fileId) throw new CloudStorageError('rate_limited', '429', true);
    return { status: 200, stream: Readable.from([fileId]), headers: {} };
  },
});

const cf = (id: string, type: string, size: number | null, hash: string) => ({
  remoteFileId: id,
  name: `${id}.x`,
  contentType: type,
  size,
  contentHash: hash,
});

const importRow = (over: Row = {}): Row => ({
  id: 'imp1',
  eventId: 'ev1',
  orgId: 'org1',
  photographerUserId: 'ph1',
  provider: 'gdrive',
  remoteFolderId: 'folder1',
  status: 'pending',
  startedAt: null,
  ...over,
});

const config = (over: Row = {}): Row => ({
  id: 'cfg1',
  orgId: 'org1',
  type: 'gdrive',
  enabled: true,
  encryptedCredentials: 'enc-old',
  ...over,
});

beforeEach(async () => {
  store = { imports: [], files: [], configs: [], photos: [] };
  h.token = { accessToken: 'AT', refreshToken: 'RT', expiresAt: 9_999_999_999 };
  const { schema } = await import('@pkg/db');
  (schema.cloudImports.cloudImports as { __t?: string }).__t = 'imports';
  (schema.cloudImports.cloudImportFiles as { __t?: string }).__t = 'files';
  (schema.integrations.integrationConfigs as { __t?: string }).__t = 'configs';
  (schema.photos.photos as { __t?: string }).__t = 'photos';
  job = await import('../src/jobs/cloud-import.js');
});

describe('runCloudImport', () => {
  it('imports a new folder: seeds files, streams to R2, enqueues ingest, completes', async () => {
    store.imports = [importRow()];
    store.configs = [config()];
    stub = makeStub([cf('A', 'image/jpeg', 100, 'hA'), cf('B', 'image/png', 200, 'hB')]);
    const d = deps();
    const res = await job.runCloudImport(makeDb() as never, d as never);
    expect(res).toMatchObject({ importsProcessed: 1, filesImported: 2, filesFailed: 0 });
    expect(d.uploader).toHaveBeenCalledTimes(2);
    expect(d.ingestQueue.add).toHaveBeenCalledTimes(2);
    // stable, content-hash-scoped ingest job id.
    expect((d.ingestQueue.add.mock.calls[0] as unknown[])[2]).toMatchObject({
      jobId: 'cloud:imp1:hA',
    });
    expect(store.imports[0]).toMatchObject({
      status: 'completed',
      totalFiles: 2,
      importedFiles: 2,
      failedFiles: 0,
    });
    expect(store.files.every((f) => f.status === 'imported' && f.photoId)).toBe(true);
  });

  it('resumes: re-listing skips an already-imported file (no duplicate import)', async () => {
    store.imports = [importRow()];
    store.configs = [config()];
    store.files = [
      {
        id: 'files-1',
        cloudImportId: 'imp1',
        contentHash: 'hA',
        status: 'imported',
        photoId: 'p0',
      },
    ];
    stub = makeStub([cf('A', 'image/jpeg', 100, 'hA'), cf('B', 'image/png', 200, 'hB')]);
    const d = deps();
    const res = await job.runCloudImport(makeDb() as never, d as never);
    // Only B is imported; A was already done.
    expect(res.filesImported).toBe(1);
    expect(d.ingestQueue.add).toHaveBeenCalledTimes(1);
    expect(store.imports[0]).toMatchObject({ status: 'completed', importedFiles: 2 });
  });

  it('isolates a failed file: others import, the import still completes', async () => {
    store.imports = [importRow()];
    store.configs = [config()];
    stub = makeStub([cf('A', 'image/jpeg', 100, 'hA'), cf('B', 'image/jpeg', 100, 'hB')], {
      failOn: 'B',
      error: new CloudStorageError('not_found', 'gone'),
    });
    const d = deps();
    const res = await job.runCloudImport(makeDb() as never, d as never);
    expect(res).toMatchObject({ filesImported: 1, filesFailed: 1 });
    expect(store.imports[0]).toMatchObject({
      status: 'completed',
      importedFiles: 1,
      failedFiles: 1,
    });
    const failed = store.files.find((f) => f.contentHash === 'hB');
    expect(failed).toMatchObject({ status: 'failed' });
  });

  it('pre-fails a file with no size and never enqueues it', async () => {
    store.imports = [importRow()];
    store.configs = [config()];
    stub = makeStub([cf('A', 'image/jpeg', null, 'hA')]);
    const d = deps();
    await job.runCloudImport(makeDb() as never, d as never);
    expect(d.ingestQueue.add).not.toHaveBeenCalled();
    expect(store.files[0]).toMatchObject({ status: 'failed', error: 'missing_size' });
    expect(store.imports[0]).toMatchObject({ status: 'completed', failedFiles: 1 });
  });

  it('pre-fails an unsupported content type', async () => {
    store.imports = [importRow()];
    store.configs = [config()];
    stub = makeStub([cf('A', 'image/heif', 100, 'hA')]);
    await job.runCloudImport(makeDb() as never, deps() as never);
    expect(store.files[0]).toMatchObject({ status: 'failed', error: 'unsupported_type' });
    expect(store.imports[0]).toMatchObject({ status: 'completed', failedFiles: 1 });
  });

  it('refreshes + re-encrypts an expired token before importing', async () => {
    h.token = { accessToken: 'AT', refreshToken: 'RT', expiresAt: 1000 }; // long past
    store.imports = [importRow()];
    store.configs = [config()];
    stub = makeStub([cf('A', 'image/jpeg', 100, 'hA')]);
    const d = deps();
    await job.runCloudImport(makeDb() as never, d as never);
    expect(d.refreshToken).toHaveBeenCalledWith('gdrive', 'RT');
    expect(store.configs[0]?.encryptedCredentials).toBe('enc-new');
    expect(store.imports[0]).toMatchObject({ status: 'completed', importedFiles: 1 });
  });

  it('fails an import whose org has no connected integration', async () => {
    store.imports = [importRow()];
    store.configs = []; // not connected
    stub = makeStub([]);
    const d = deps();
    await job.runCloudImport(makeDb() as never, d as never);
    expect(d.ingestQueue.add).not.toHaveBeenCalled();
    expect(store.imports[0]).toMatchObject({
      status: 'failed',
      lastError: 'integration_not_connected',
    });
  });

  it('stops the tick on a rate limit and leaves the import running', async () => {
    store.imports = [importRow()];
    store.configs = [config()];
    stub = makeStub([cf('A', 'image/jpeg', 100, 'hA'), cf('B', 'image/jpeg', 100, 'hB')], {
      rateLimitOn: 'A',
    });
    const d = deps();
    const res = await job.runCloudImport(makeDb() as never, d as never);
    expect(res.filesImported).toBe(0);
    expect(store.imports[0]).toMatchObject({ status: 'running', lastError: 'rate_limited' });
  });
});
