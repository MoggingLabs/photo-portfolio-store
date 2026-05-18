// F1.33 — biometric consent service + routes tests.
//
// In-memory store mirrors the search.test.ts pattern. We exercise both the
// service surface (grantConsent / verifyConsent / revokeConsent /
// incrementSearchUsage) and the route surface end-to-end via app.inject().

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory store ----------

type Row = Record<string, unknown>;

interface Store {
  events: Row[];
  consents: Row[];
  auditLog: Row[];
  faceVectors: Row[];
}

const newStore = (): Store => ({
  events: [],
  consents: [],
  auditLog: [],
  faceVectors: [],
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
  const n = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
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
    photos: tableMarker('events'),
    photoDerivatives: tableMarker('events'),
    uploadSessions: tableMarker('events'),
  };
  const searchTbl = {
    bibTags: tableMarker('events'),
    searchSessions: tableMarker('events'),
    searchMatches: tableMarker('events'),
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

// ---------- Fake DB ----------

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
        joinPred = (joined: Row) => pred(joined);
        return api;
      },
      innerJoin(table: Row, pred: (joined: Row) => boolean) {
        joinBucket = table[TABLE_KEY] as keyof Store;
        joinPred = (joined: Row) => pred(joined);
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
            if (!merged) out.push(l); // leftJoin behaviour
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
              else projected[alias] = row;
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
              // Handle sql increments expressed as functions in our shim.
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

  const deleteBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        store[bucket] = store[bucket].filter((r) => !filters.every((f) => f(r)));
        return resolve([]);
      },
    };
    return api;
  };

  return {
    select: (s?: Record<string, unknown>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
    update: (t: Row) => updateBuilder(t),
    delete: (t: Row) => deleteBuilder(t),
  };
};

// ---------- drizzle-orm shim ----------

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
  const lt = (a: unknown, b: unknown) => (row: Row) =>
    (valueOf(a, row) as number) < (valueOf(b, row) as number);
  const ilike = () => () => true;
  const asc = (f: Field) => (a: Row, b: Row) =>
    (a[f.column] as number) > (b[f.column] as number) ? 1 : -1;
  const desc = (f: Field) => (a: Row, b: Row) =>
    (a[f.column] as number) < (b[f.column] as number) ? 1 : -1;

  // sql tag returns a function that, depending on context, either evaluates
  // as a predicate (true) or acts as an update fragment for searches_used+1.
  type SqlFn = ((row: Row) => unknown) & { __increment?: string };
  const sqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const joined = strings.join('?').toLowerCase();
    if (joined.includes('+ 1') || joined.includes('+1')) {
      // Find the field being incremented.
      const field = values.find((v) => isField(v)) as Field | undefined;
      const fn: SqlFn = ((row: Row) =>
        Number(row[field?.column ?? 'searchesUsed'] ?? 0) + 1) as SqlFn;
      fn.__increment = field?.column;
      return fn;
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

  return { eq, and, or, isNull, inArray, lt, ilike, asc, desc, sql: sqlTag };
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
    'actorUserId',
    'targetKind',
    'targetId',
    'eventId',
    'payloadJsonb',
  ]);
  tag(schema.search.tables.faceVectors as Record<string, unknown>, [
    'id',
    'eventId',
    'photoId',
    'qdrantPointId',
  ]);
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';

const seedPublishedEvent = (overrides: Partial<Row> = {}): void => {
  store.events.push({
    id: EVENT_ID,
    status: 'published',
    allowFaceSearch: true,
    retentionDays: 30,
    eventDate: new Date('2026-05-01T00:00:00Z'),
    archivedAt: null,
    ...overrides,
  });
};

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------- Service tests ----------

const goodAcks = {
  biometricProcessing: true as const,
  retentionPeriod: true as const,
  rightToErasure: true as const,
  jurisdictionRules: true as const,
};

describe('grantConsent', () => {
  it('inserts an active biometric consent row and audits granted', async () => {
    seedPublishedEvent();
    const { grantConsent } = await import('../src/services/consents.js');
    const res = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
      { ipHash: 'iphash1', userAgent: 'ua1' },
    );
    expect(res.id).toBeTruthy();
    expect(res.searchesRemaining).toBe(20);
    expect(store.consents).toHaveLength(1);
    expect(store.consents[0]).toMatchObject({
      scope: 'biometric',
      eventId: EVENT_ID,
      jurisdiction: 'eu_gdpr',
      searchesUsed: 0,
      ipHash: 'iphash1',
      userAgent: 'ua1',
    });
    expect(store.auditLog.some((r) => r.action === 'biometric.consent.granted')).toBe(true);
  });

  it('rejects unknown policyVersion with unsupported_policy_version', async () => {
    seedPublishedEvent();
    const { grantConsent, ConsentValidationError } = await import('../src/services/consents.js');
    await expect(
      grantConsent(
        db as never,
        {
          eventId: EVENT_ID,
          locale: 'en-US',
          policyVersion: '1999-01-01',
          acknowledgements: goodAcks,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(ConsentValidationError);
  });

  it('rejects when an acknowledgement is missing', async () => {
    seedPublishedEvent();
    const { grantConsent, ConsentValidationError } = await import('../src/services/consents.js');
    await expect(
      grantConsent(
        db as never,
        {
          eventId: EVENT_ID,
          locale: 'en-US',
          policyVersion: '2026-05-18',
          acknowledgements: { ...goodAcks, biometricProcessing: false as never },
        },
        {},
      ),
    ).rejects.toBeInstanceOf(ConsentValidationError);
  });

  it('returns event_not_found when event missing or face-search disabled', async () => {
    seedPublishedEvent({ allowFaceSearch: false });
    const { grantConsent, ConsentValidationError } = await import('../src/services/consents.js');
    await expect(
      grantConsent(
        db as never,
        {
          eventId: EVENT_ID,
          locale: 'en-US',
          policyVersion: '2026-05-18',
          acknowledgements: goodAcks,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'event_not_found' } as Partial<
      InstanceType<typeof ConsentValidationError>
    >);
  });

  it('is idempotent on duplicate (email+event) — returns existing', async () => {
    seedPublishedEvent();
    const { grantConsent } = await import('../src/services/consents.js');
    const first = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        email: 'alice@example.com',
        acknowledgements: goodAcks,
      },
      {},
    );
    const second = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        email: 'ALICE@example.com',
        acknowledgements: goodAcks,
      },
      {},
    );
    expect(second.id).toBe(first.id);
    expect(store.consents).toHaveLength(1);
  });
});

describe('verifyConsent', () => {
  const grantFresh = async (overrides: Partial<Row> = {}) => {
    seedPublishedEvent();
    const { grantConsent } = await import('../src/services/consents.js');
    const res = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
      { ipHash: 'iphash1', userAgent: 'ua1' },
    );
    // Apply overrides directly on the row.
    if (Object.keys(overrides).length > 0) {
      Object.assign(store.consents[0]!, overrides);
    }
    return res.id;
  };

  it('returns ok on a fresh consent with matching bind', async () => {
    const id = await grantFresh();
    const { verifyConsent } = await import('../src/services/consents.js');
    const r = await verifyConsent(db as never, id, EVENT_ID, {
      ipHash: 'iphash1',
      userAgent: 'ua1',
    });
    expect(r.ok).toBe(true);
  });

  it('returns expired when expiresAt is in the past', async () => {
    const id = await grantFresh({ expiresAt: new Date(Date.now() - 1000) });
    const { verifyConsent } = await import('../src/services/consents.js');
    const r = await verifyConsent(db as never, id, EVENT_ID, {
      ipHash: 'iphash1',
      userAgent: 'ua1',
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('expired');
  });

  it('returns revoked when revokedAt set', async () => {
    const id = await grantFresh({ revokedAt: new Date() });
    const { verifyConsent } = await import('../src/services/consents.js');
    const r = await verifyConsent(db as never, id, EVENT_ID, {
      ipHash: 'iphash1',
      userAgent: 'ua1',
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('revoked');
  });

  it('returns quota_exhausted when searchesUsed >= 20', async () => {
    const id = await grantFresh({ searchesUsed: 20 });
    const { verifyConsent } = await import('../src/services/consents.js');
    const r = await verifyConsent(db as never, id, EVENT_ID, {
      ipHash: 'iphash1',
      userAgent: 'ua1',
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('quota_exhausted');
  });

  it('returns wrong_event when consent is for a different event', async () => {
    const id = await grantFresh();
    const { verifyConsent } = await import('../src/services/consents.js');
    const r = await verifyConsent(db as never, id, '00000000-0000-4000-8000-000000000999', {
      ipHash: 'iphash1',
      userAgent: 'ua1',
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('wrong_event');
  });

  it('returns bind_mismatch and writes suspicious_reuse audit on full mismatch', async () => {
    const id = await grantFresh();
    const { verifyConsent } = await import('../src/services/consents.js');
    const r = await verifyConsent(db as never, id, EVENT_ID, {
      ipHash: 'iphash-different',
      userAgent: 'ua-different',
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('bind_mismatch');
    expect(store.auditLog.some((a) => a.action === 'consent.suspicious_reuse')).toBe(true);
  });

  it('tolerates partial bind (only IP changes — mobile→wifi case)', async () => {
    const id = await grantFresh();
    const { verifyConsent } = await import('../src/services/consents.js');
    const r = await verifyConsent(db as never, id, EVENT_ID, {
      ipHash: 'iphash-different',
      userAgent: 'ua1',
    });
    expect(r.ok).toBe(true);
  });
});

describe('incrementSearchUsage', () => {
  it('increments under quota and returns new value', async () => {
    seedPublishedEvent();
    const { grantConsent, incrementSearchUsage } = await import('../src/services/consents.js');
    const res = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
      {},
    );
    const v1 = await incrementSearchUsage(db as never, res.id);
    expect(v1).toBe(1);
    const v2 = await incrementSearchUsage(db as never, res.id);
    expect(v2).toBe(2);
  });

  it('throws QuotaExhaustedError at the cap', async () => {
    seedPublishedEvent();
    const { grantConsent, incrementSearchUsage, QuotaExhaustedError } = await import(
      '../src/services/consents.js'
    );
    const res = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
      {},
    );
    Object.assign(store.consents[0]!, { searchesUsed: 20 });
    await expect(incrementSearchUsage(db as never, res.id)).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
  });
});

describe('revokeConsent', () => {
  it('marks the consent revoked and writes audit', async () => {
    seedPublishedEvent();
    const { grantConsent, revokeConsent } = await import('../src/services/consents.js');
    const res = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
      {},
    );
    await revokeConsent(
      db as never,
      res.id,
      {},
      {
        countVectorsForEvent: async () => 3,
        hasOtherActiveConsents: async () => false,
        deleteVectorsForEvent: async () => undefined,
      },
    );
    expect(store.consents[0]?.revokedAt).toBeTruthy();
    expect(store.auditLog.some((r) => r.action === 'biometric.consent.revoked')).toBe(true);
  });

  it('is idempotent on already-revoked consents', async () => {
    seedPublishedEvent();
    const { grantConsent, revokeConsent } = await import('../src/services/consents.js');
    const res = await grantConsent(
      db as never,
      {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
      {},
    );
    await revokeConsent(
      db as never,
      res.id,
      {},
      {
        hasOtherActiveConsents: async () => false,
        countVectorsForEvent: async () => 0,
        deleteVectorsForEvent: async () => undefined,
      },
    );
    const second = await revokeConsent(
      db as never,
      res.id,
      {},
      {
        hasOtherActiveConsents: async () => false,
        countVectorsForEvent: async () => 0,
        deleteVectorsForEvent: async () => undefined,
      },
    );
    expect(second.vectorsPurged).toBe(0);
  });
});

// ---------- Route tests ----------

const importRoutes = async () => (await import('../src/routes/consents.js')).default;

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  const routes = await importRoutes();
  await app.register(routes, { db: db as never });
  return app;
};

describe('consent routes', () => {
  it('POST /v1/consents/biometric grants and sets HMAC cookie', async () => {
    seedPublishedEvent();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents/biometric',
      payload: {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.consent.id).toBeTruthy();
    expect(body.consent.searchesRemaining).toBe(20);
    expect(res.headers['set-cookie']).toMatch(/pps_consent_/);
    await app.close();
  });

  it('returns 422 on unsupported policy version', async () => {
    seedPublishedEvent();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents/biometric',
      payload: {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: 'ghost',
        acknowledgements: goodAcks,
      },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('returns 400 on bad body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents/biometric',
      payload: { eventId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('DELETE without proof returns 404 (anti-enumeration)', async () => {
    seedPublishedEvent();
    const app = await buildApp();
    const grant = await app.inject({
      method: 'POST',
      url: '/v1/consents/biometric',
      payload: {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
    });
    const consentId = grant.json().consent.id as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/consents/biometric/${consentId}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE with correct cookie proof revokes', async () => {
    seedPublishedEvent();
    const app = await buildApp();
    const grant = await app.inject({
      method: 'POST',
      url: '/v1/consents/biometric',
      payload: {
        eventId: EVENT_ID,
        locale: 'en-US',
        policyVersion: '2026-05-18',
        acknowledgements: goodAcks,
      },
    });
    const consentId = grant.json().consent.id as string;
    const cookieHeader = grant.headers['set-cookie'] as string;
    const cookie = cookieHeader.split(';')[0]!;
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/consents/biometric/${consentId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(store.consents[0]?.revokedAt).toBeTruthy();
    await app.close();
  });
});
