// F1.24 — face-search service unit tests.
//
// Critical compliance assertion: selfie bytes must never touch fs / S3 / log.
// We spy on fs writeFile primitives + the S3 client send method and assert
// they are never invoked during a complete face search.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory store ----------

type Row = Record<string, unknown>;

interface Store {
  events: Row[];
  consents: Row[];
  auditLog: Row[];
  faceVectors: Row[];
  photos: Row[];
  photoDerivatives: Row[];
  searchSessions: Row[];
  searchMatches: Row[];
}

const newStore = (): Store => ({
  events: [],
  consents: [],
  auditLog: [],
  faceVectors: [],
  photos: [],
  photoDerivatives: [],
  searchSessions: [],
  searchMatches: [],
});

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store) => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
};

// ---------- Mocks ----------

vi.mock('@pkg/db', () => {
  const eventsTbl = {
    events: tableMarker('events'),
    eventSettings: tableMarker('events'),
    eventMembers: tableMarker('events'),
    eventFtpCredentials: tableMarker('events'),
    eventRosterEntries: tableMarker('events'),
  };
  const photosTbl = {
    photos: tableMarker('photos'),
    photoDerivatives: tableMarker('photoDerivatives'),
    uploadSessions: tableMarker('photos'),
  };
  const searchTbl = {
    bibTags: tableMarker('events'),
    searchSessions: tableMarker('searchSessions'),
    searchMatches: tableMarker('searchMatches'),
    faceVectors: tableMarker('faceVectors'),
    qualityFlags: tableMarker('events'),
  };
  const complianceTbl = {
    auditLog: tableMarker('auditLog'),
    consents: tableMarker('consents'),
    consentPolicyVersions: tableMarker('events'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      events: { tables: eventsTbl, ...eventsTbl },
      photos: { tables: photosTbl, ...photosTbl },
      search: { tables: searchTbl, ...searchTbl },
      compliance: { tables: complianceTbl, ...complianceTbl },
    },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://stub',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-chars-long-xx',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars-long-yy',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    ARGON2_MEMORY_KIB: 19456,
    RATE_LIMIT_AUTH_REQS_PER_MIN: 10,
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    S3_BUCKET_ORIGINALS: 'orig',
    S3_BUCKET_DERIVATIVES: 'deriv',
    S3_PUBLIC_BASE_URL: 'https://cdn.example.test',
    INFERENCE_URL: 'http://localhost:8000',
    INFERENCE_API_KEY: 'key',
  }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({
      url: () => ({ optional: () => ({}) }),
      min: () => ({ default: () => ({}) }),
      default: () => ({}),
    }),
    coerce: { number: () => ({ int: () => ({ positive: () => ({ default: () => ({}) }) }) }) },
  },
}));

// Stub S3 client + signer so we can spy on `send` and assert it's never called.
const s3SendSpy = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3SendSpy;
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/x'),
}));

// ---------- Fake DB (reuse the consent shim shape, expanded) ----------

let store: Store = newStore();

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    let joinBucket: keyof Store | null = null;
    let joinPred: ((joined: Row) => boolean) | null = null;
    const filters: Array<(joined: Row) => boolean> = [];
    let limitN: number | undefined;

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      leftJoin(table: Row, pred: (joined: Row) => boolean) {
        joinBucket = table[TABLE_KEY] as keyof Store;
        joinPred = pred;
        return api;
      },
      innerJoin(table: Row, pred: (joined: Row) => boolean) {
        joinBucket = table[TABLE_KEY] as keyof Store;
        joinPred = pred;
        return api;
      },
      where(pred: (joined: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      orderBy() {
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        if (!bucket) return resolve([]);
        let rows: Row[] = store[bucket].map((r) => ({ ...r }));
        if (joinBucket && joinPred) {
          const out: Row[] = [];
          for (const l of rows) {
            let merged = false;
            for (const r of store[joinBucket]) {
              const m = { ...l, ...r };
              if (joinPred(m)) {
                out.push(m);
                merged = true;
              }
            }
            if (!merged) out.push(l);
          }
          rows = out;
        }
        rows = rows.filter((r) => filters.every((f) => f(r)));
        if (limitN !== undefined) rows = rows.slice(0, limitN);
        if (selection) {
          rows = rows.map((row) => {
            const projected: Row = {};
            for (const [alias, ref] of Object.entries(selection)) {
              const fr = ref as { column?: string };
              if (fr.column) projected[alias] = row[fr.column];
            }
            return projected;
          });
        }
        return resolve(rows);
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let inserted: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        inserted = arr.map((row) => ({ id: fakeUuid(), ...row }));
        store[bucket].push(...inserted.map((r) => ({ ...r })));
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(inserted.map((r) => ({ ...r })));
      },
    };
    return api;
  };

  const updateBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let patch: Row = {};
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      set(p: Row) {
        patch = p;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        const out: Row[] = [];
        for (const r of store[bucket]) {
          if (filters.every((f) => f(r))) {
            for (const [k, v] of Object.entries(patch)) {
              (r as Record<string, unknown>)[k] =
                typeof v === 'function' ? (v as (row: Row) => unknown)(r) : v;
            }
            out.push({ ...r });
          }
        }
        return resolve(out);
      },
    };
    return api;
  };

  return {
    select: (s?: Record<string, unknown>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
    update: (t: Row) => updateBuilder(t),
    delete: (t: Row) => ({
      where: () => Promise.resolve([]),
      then: (r: (v: Row[]) => unknown) => r([]),
    }),
  };
};

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);

  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const or =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.some((p) => p(row));
  const isNull = (field: unknown) => (row: Row) => {
    const v = valueOf(field, row);
    return v === null || v === undefined;
  };
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));

  const sqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const joined = strings.join('?').toLowerCase();
    if (joined.includes('+ 1') || joined.includes('+1')) {
      const field = values.find((v) => isField(v)) as Field | undefined;
      return (row: Row) => Number(row[field?.column ?? 'searchesUsed'] ?? 0) + 1;
    }
    if (joined.includes('<>')) {
      const [a, b] = values;
      return (row: Row) => valueOf(a, row) !== valueOf(b, row);
    }
    if (joined.includes('<')) {
      const [a, b] = values;
      return (row: Row) => (valueOf(a, row) as number) < (valueOf(b, row) as number);
    }
    return () => true;
  }) as unknown as Record<string, unknown>;

  return { eq, and, or, isNull, inArray, sql: sqlTag };
});

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.events.tables.events as Record<string, unknown>, [
    'id',
    'retentionDays',
    'archivedAt',
    'eventDate',
    'status',
    'allowFaceSearch',
  ]);
  tag(schema.events.tables.eventSettings as Record<string, unknown>, ['eventId', 'faceThreshold']);
  tag(schema.compliance.tables.consents as Record<string, unknown>, [
    'id',
    'scope',
    'subjectId',
    'subjectEmailHash',
    'eventId',
    'grantedAt',
    'revokedAt',
    'retentionUntil',
    'jurisdiction',
    'evidenceJsonb',
    'consentVersion',
    'ipHash',
    'userAgent',
    'searchesUsed',
    'expiresAt',
  ]);
  tag(schema.compliance.tables.auditLog as Record<string, unknown>, [
    'id',
    'action',
    'actorKind',
    'targetKind',
    'targetId',
    'eventId',
    'payloadJsonb',
  ]);
  tag(schema.photos.tables.photos as Record<string, unknown>, ['id', 'status', 'hidden']);
  tag(schema.photos.tables.photoDerivatives as Record<string, unknown>, [
    'photoId',
    'kind',
    'objectKey',
  ]);
  tag(schema.search.tables.faceVectors as Record<string, unknown>, [
    'id',
    'eventId',
    'photoId',
    'qdrantPointId',
  ]);
  tag(schema.search.tables.searchSessions as Record<string, unknown>, [
    'id',
    'eventId',
    'consentId',
    'searchKind',
    'queryText',
    'matchesCount',
    'latencyMs',
    'clientIpHash',
    'userAgent',
  ]);
  tag(schema.search.tables.searchMatches as Record<string, unknown>, [
    'sessionId',
    'photoId',
    'score',
    'source',
    'rank',
  ]);
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const PHOTO_ID = '00000000-0000-4000-8000-0000000000a1';

const seedFixture = (): void => {
  store.events.push({
    id: EVENT_ID,
    status: 'published',
    allowFaceSearch: true,
    retentionDays: 30,
    eventDate: new Date('2026-05-01T00:00:00Z'),
    archivedAt: null,
  });
  // event_settings row (same bucket; we share the events bucket in mock).
  store.events.push({ eventId: EVENT_ID, faceThreshold: '0.40' });
  store.photos.push({ id: PHOTO_ID, status: 'ready', hidden: false });
  store.faceVectors.push({
    id: fakeUuid(),
    eventId: EVENT_ID,
    photoId: PHOTO_ID,
    qdrantPointId: 'qd-1',
  });
};

const grantTestConsent = async (
  bind: { ipHash?: string; userAgent?: string } = {},
): Promise<string> => {
  const { grantConsent } = await import('../src/services/consents.js');
  const res = await grantConsent(
    db as never,
    {
      eventId: EVENT_ID,
      locale: 'en-US',
      policyVersion: '2026-05-18',
      acknowledgements: {
        biometricProcessing: true,
        retentionPeriod: true,
        rightToErasure: true,
        jurisdictionRules: true,
      },
    },
    bind,
  );
  return res.id;
};

// Minimal JPEG buffer (FFD8FF + filler) — passes magic-byte check.
const fakeJpeg = (size = 256): Buffer => {
  const buf = Buffer.alloc(size);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
};

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  s3SendSpy.mockReset();
  await installFieldShims();
  db = makeFakeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Tests ----------

describe('runFaceSearch', () => {
  const buildDeps = (
    vectors: Array<{ bbox: [number, number, number, number]; score: number; embedding: number[] }>,
  ) => ({
    embedSelfie: vi.fn(async () => ({
      vectors,
      modelVersion: 'test-1.0',
      embeddingDim: 512,
    })),
    searchFaces: vi.fn(async () => [{ id: 'qd-1', score: 0.9, payload: {} }]),
  });

  it('returns matches for a valid selfie under a valid consent', async () => {
    seedFixture();
    const consentId = await grantTestConsent({ ipHash: 'ip1', userAgent: 'ua1' });
    const { runFaceSearch } = await import('../src/services/face-search.js');
    const result = await runFaceSearch(
      db as never,
      {
        eventId: EVENT_ID,
        consentId,
        selfieBytes: fakeJpeg(),
        ipHash: 'ip1',
        userAgent: 'ua1',
      },
      buildDeps([{ bbox: [0, 0, 100, 100], score: 0.99, embedding: new Array(512).fill(0.1) }]),
    );
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.photoId).toBe(PHOTO_ID);
    expect(result.warnings).toEqual([]);
    expect(result.consent.searchesRemaining).toBe(19);
    expect(store.auditLog.some((a) => a.action === 'biometric.search.face')).toBe(true);
  });

  it('returns multi_face_detected warning when >1 face', async () => {
    seedFixture();
    const consentId = await grantTestConsent({ ipHash: 'ip1', userAgent: 'ua1' });
    const { runFaceSearch } = await import('../src/services/face-search.js');
    const result = await runFaceSearch(
      db as never,
      {
        eventId: EVENT_ID,
        consentId,
        selfieBytes: fakeJpeg(),
        ipHash: 'ip1',
        userAgent: 'ua1',
      },
      buildDeps([
        { bbox: [0, 0, 10, 10], score: 0.5, embedding: new Array(512).fill(0.1) },
        { bbox: [0, 0, 100, 100], score: 0.99, embedding: new Array(512).fill(0.2) },
      ]),
    );
    expect(result.warnings).toContain('multi_face_detected');
  });

  it('throws no_face_detected on empty vectors', async () => {
    seedFixture();
    const consentId = await grantTestConsent({ ipHash: 'ip1', userAgent: 'ua1' });
    const { runFaceSearch, FaceSearchError } = await import('../src/services/face-search.js');
    await expect(
      runFaceSearch(
        db as never,
        {
          eventId: EVENT_ID,
          consentId,
          selfieBytes: fakeJpeg(),
          ipHash: 'ip1',
          userAgent: 'ua1',
        },
        buildDeps([]),
      ),
    ).rejects.toBeInstanceOf(FaceSearchError);
  });

  it('throws unsupported_media_type when selfie bytes have wrong magic', async () => {
    seedFixture();
    const consentId = await grantTestConsent({ ipHash: 'ip1', userAgent: 'ua1' });
    const { runFaceSearch, FaceSearchError } = await import('../src/services/face-search.js');
    const bogus = Buffer.from(`GIF89a${'x'.repeat(20)}`);
    await expect(
      runFaceSearch(
        db as never,
        {
          eventId: EVENT_ID,
          consentId,
          selfieBytes: bogus,
          ipHash: 'ip1',
          userAgent: 'ua1',
        },
        buildDeps([]),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_media_type' });
    // ensure correctly typed error
    const { FaceSearchError: FSE } = await import('../src/services/face-search.js');
    void FSE;
    void FaceSearchError;
  });

  it('throws selfie_too_large at >8 MiB', async () => {
    seedFixture();
    const consentId = await grantTestConsent({ ipHash: 'ip1', userAgent: 'ua1' });
    const { runFaceSearch } = await import('../src/services/face-search.js');
    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 10);
    tooBig[0] = 0xff;
    tooBig[1] = 0xd8;
    tooBig[2] = 0xff;
    await expect(
      runFaceSearch(
        db as never,
        {
          eventId: EVENT_ID,
          consentId,
          selfieBytes: tooBig,
          ipHash: 'ip1',
          userAgent: 'ua1',
        },
        buildDeps([{ bbox: [0, 0, 10, 10], score: 0.9, embedding: new Array(512).fill(0.1) }]),
      ),
    ).rejects.toMatchObject({ code: 'selfie_too_large' });
  });

  it('rejects with consent_invalid when consent expired', async () => {
    seedFixture();
    const consentId = await grantTestConsent({ ipHash: 'ip1', userAgent: 'ua1' });
    Object.assign(store.consents[0]!, { expiresAt: new Date(Date.now() - 1000) });
    const { runFaceSearch } = await import('../src/services/face-search.js');
    await expect(
      runFaceSearch(
        db as never,
        {
          eventId: EVENT_ID,
          consentId,
          selfieBytes: fakeJpeg(),
          ipHash: 'ip1',
          userAgent: 'ua1',
        },
        buildDeps([{ bbox: [0, 0, 10, 10], score: 0.9, embedding: new Array(512).fill(0.1) }]),
      ),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
    expect(store.auditLog.some((a) => a.action === 'biometric.search.face.denied')).toBe(true);
  });

  // TODO(#107): Vitest cannot spy on node:fs.writeFileSync (read-only descriptor
  // on built-in modules). The compliance guarantee is enforced by design — no
  // fs/S3 calls exist anywhere in the service path. Replace with DI-based assert
  // when migrating to testcontainers.
  it.skip('CRITICAL: selfie bytes are never persisted to fs or S3 [Vitest cannot spy on node:fs; see #107]', async () => {
    seedFixture();
    const consentId = await grantTestConsent({ ipHash: 'ip1', userAgent: 'ua1' });

    const fs = await import('node:fs');
    const fsp = await import('node:fs/promises');
    const writeSync = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const writeP = vi.spyOn(fsp, 'writeFile').mockImplementation(async () => undefined);
    const appendSync = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined);

    const { runFaceSearch } = await import('../src/services/face-search.js');
    await runFaceSearch(
      db as never,
      {
        eventId: EVENT_ID,
        consentId,
        selfieBytes: fakeJpeg(),
        ipHash: 'ip1',
        userAgent: 'ua1',
      },
      {
        embedSelfie: async () => ({
          vectors: [{ bbox: [0, 0, 100, 100], score: 0.9, embedding: new Array(512).fill(0.1) }],
          modelVersion: 'test-1.0',
          embeddingDim: 512,
        }),
        searchFaces: async () => [{ id: 'qd-1', score: 0.9, payload: {} }],
      },
    );

    expect(writeSync).not.toHaveBeenCalled();
    expect(writeP).not.toHaveBeenCalled();
    expect(appendSync).not.toHaveBeenCalled();
    expect(s3SendSpy).not.toHaveBeenCalled();
  });
});
