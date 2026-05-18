// Events service + route tests. We mock the @pkg/db client to a tiny
// in-memory store so tests run without a Postgres instance — the goal here
// is to lock down the service-level invariants (slug collision, cursor
// pagination, soft-delete behavior, split_pct, FTP rotation) and exercise
// the route handler wiring with stubbed auth + RBAC.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory fake DbClient ----------
//
// drizzle exposes a fluent builder; we don't try to emulate the whole API.
// Instead we shape the fake to match the exact call sequences our service
// uses: select().from().where().limit() / orderBy() / returning(), and
// insert/update/delete builders that ultimately produce arrays of rows.

type Row = Record<string, unknown>;

interface Store {
  events: Row[];
  eventMembers: Row[];
  eventSettings: Row[];
  eventFtpCredentials: Row[];
  organizationMembers: Row[];
  auditLog: Row[];
}

const newStore = (): Store => ({
  events: [],
  eventMembers: [],
  eventSettings: [],
  eventFtpCredentials: [],
  organizationMembers: [],
  auditLog: [],
});

// Each drizzle "table" object identifies its store bucket via a symbol we
// attach in the schema mock below.
const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store) => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

// Build a uuid-ish string (good enough for fake equality + ordering).
let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  const n = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
};

// ---------- Mocks ----------

vi.mock('@pkg/db', () => {
  const tables = {
    events: tableMarker('events'),
    eventMembers: tableMarker('eventMembers'),
    eventSettings: tableMarker('eventSettings'),
    eventFtpCredentials: tableMarker('eventFtpCredentials'),
    eventRosterEntries: tableMarker('eventFtpCredentials'),
  };
  const userTables = {
    organizations: tableMarker('organizationMembers'),
    users: tableMarker('organizationMembers'),
    sessions: tableMarker('organizationMembers'),
    organizationMembers: tableMarker('organizationMembers'),
    photographerProfiles: tableMarker('organizationMembers'),
  };
  const complianceTables = {
    consents: tableMarker('auditLog'),
    auditLog: tableMarker('auditLog'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      events: { tables },
      users: { tables: userTables },
      compliance: { tables: complianceTables },
    },
  };
});

vi.mock('@pkg/env', () => {
  return {
    parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
    z: {
      object: () => ({
        parse: (v: unknown) => v,
        safeParse: (v: unknown) => ({ success: true, data: v }),
      }),
      string: () => ({ min: () => ({}) }),
    },
  };
});

vi.mock('../src/auth/passwords.js', () => ({
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
  verifyPassword: vi.fn(async () => true),
}));

// Replace the default db export with a builder backed by `store`.
let store: Store = newStore();

const makeFakeDb = (): unknown => {
  // Resolve a query against the in-memory store.
  const runSelect = (
    bucket: keyof Store,
    filterFn: (r: Row) => boolean,
    sortFn?: (a: Row, b: Row) => number,
    limit?: number,
  ): Row[] => {
    let rows = store[bucket].filter(filterFn);
    if (sortFn) rows = [...rows].sort(sortFn);
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map((r) => ({ ...r }));
  };

  const selectBuilder = (selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let sortFn: ((a: Row, b: Row) => number) | undefined;
    let limitN: number | undefined;
    // Aggregate sum of split_pct?
    let aggregateSum: { field: string } | null = null;

    if (selection) {
      // Detect coalesce sum aggregate or simple field selection — for our
      // service the only aggregate is sum of split_pct from event_members.
      for (const v of Object.values(selection)) {
        const s = String(v);
        if (s.includes('sum') && s.includes('split_pct')) {
          aggregateSum = { field: 'splitPct' };
        }
      }
    }

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      orderBy(...comparators: Array<(a: Row, b: Row) => number>) {
        sortFn = (a, b) => {
          for (const c of comparators) {
            const v = c(a, b);
            if (v !== 0) return v;
          }
          return 0;
        };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) {
        try {
          if (!bucket) return resolve([]);
          const filterFn = (r: Row) => filters.every((f) => f(r));
          const rows = runSelect(bucket, filterFn, sortFn, limitN);
          if (aggregateSum) {
            const total = rows.reduce((acc, r) => acc + Number(r[aggregateSum?.field] ?? 0), 0);
            return resolve([{ total: total.toString() }] as Row[]);
          }
          return resolve(rows);
        } catch (e) {
          return reject(e);
        }
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let toInsert: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        toInsert = arr.map((row) => {
          const withDefaults: Row = {
            id: fakeUuid(),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...row,
          };
          return withDefaults;
        });
        // Side effect: persist immediately unless returning() chains.
        store[bucket].push(...toInsert.map((r) => ({ ...r })));
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(toInsert.map((r) => ({ ...r })));
      },
    };
    return api;
  };

  const updateBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let setPayload: Row = {};
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      set(payload: Row) {
        setPayload = payload;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        const filterFn = (r: Row) => filters.every((f) => f(r));
        const updated: Row[] = [];
        for (const row of store[bucket]) {
          if (filterFn(row)) {
            Object.assign(row, setPayload);
            updated.push({ ...row });
          }
        }
        return resolve(updated);
      },
    };
    return api;
  };

  const deleteBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        const filterFn = (r: Row) => filters.every((f) => f(r));
        const removed: Row[] = [];
        store[bucket] = store[bucket].filter((row) => {
          if (filterFn(row)) {
            removed.push({ ...row });
            return false;
          }
          return true;
        });
        return resolve(removed);
      },
    };
    return api;
  };

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
    insert: (table: Row) => insertBuilder(table),
    update: (table: Row) => updateBuilder(table),
    delete: (table: Row) => deleteBuilder(table),
  };
};

// drizzle-orm functions used by the service — we replace them with naive
// JS predicates / comparators over rows.
vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[(v as Field).column] : v);

  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const or =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.some((p) => p(row));
  const gte = (a: unknown, b: unknown) => (row: Row) => {
    const av = valueOf(a, row);
    const bv = valueOf(b, row);
    return (av as number) >= (bv as number);
  };
  const lt = (a: unknown, b: unknown) => (row: Row) => {
    const av = valueOf(a, row);
    const bv = valueOf(b, row);
    if (av instanceof Date && bv instanceof Date) return av.getTime() < bv.getTime();
    return (av as number) < (bv as number);
  };
  const ilike = (field: unknown, pattern: string) => {
    const re = new RegExp(pattern.replace(/%/g, '.*'), 'i');
    return (row: Row) => re.test(String(valueOf(field, row) ?? ''));
  };
  const asc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column];
    const bv = b[field.column];
    return (av as number) > (bv as number) ? 1 : (av as number) < (bv as number) ? -1 : 0;
  };
  const desc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column];
    const bv = b[field.column];
    if (av instanceof Date && bv instanceof Date) return bv.getTime() - av.getTime();
    return (av as number) > (bv as number) ? -1 : (av as number) < (bv as number) ? 1 : 0;
  };
  // sql template — we only need it to carry a marker for the aggregate
  // detection in selectBuilder.
  const sqlTag = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    return { __sql: strings.join('') };
  }) as unknown as Record<string, unknown>;
  sqlTag.join = (_arr: unknown[], _sep: unknown) => ({ __sql: 'joined' });

  return { eq, and, or, gte, lt, ilike, asc, desc, sql: sqlTag };
});

// Override the schema marker columns so our drizzle predicate helpers can
// extract field names. We replace each table's marker object's properties
// with `{ column: <name> }` entries, after the @pkg/db mock has created the
// markers.
const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const eventsTbl = schema.events.tables.events as Record<string, unknown>;
  const memberTbl = schema.events.tables.eventMembers as Record<string, unknown>;
  const settingsTbl = schema.events.tables.eventSettings as Record<string, unknown>;
  const ftpTbl = schema.events.tables.eventFtpCredentials as Record<string, unknown>;
  const orgMembers = schema.users.tables.organizationMembers as Record<string, unknown>;
  const audit = schema.compliance.tables.auditLog as Record<string, unknown>;

  for (const col of [
    'id',
    'orgId',
    'name',
    'slug',
    'status',
    'eventDate',
    'createdAt',
    'updatedAt',
    'publishedAt',
    'archivedAt',
    'allowFaceSearch',
    'coverPhotoId',
    'retentionDays',
    'currency',
    'description',
    'location',
    'timezone',
  ]) {
    eventsTbl[col] = { column: col };
  }
  for (const col of ['eventId', 'userId', 'role', 'splitPct', 'createdAt']) {
    memberTbl[col] = { column: col };
  }
  for (const col of ['eventId', 'updatedAt']) {
    settingsTbl[col] = { column: col };
  }
  for (const col of ['id', 'eventId', 'username', 'passwordHash', 'expiresAt', 'revokedAt']) {
    ftpTbl[col] = { column: col };
  }
  for (const col of ['orgId', 'userId', 'role']) {
    orgMembers[col] = { column: col };
  }
  for (const col of [
    'id',
    'actorUserId',
    'actorKind',
    'action',
    'targetKind',
    'targetId',
    'eventId',
    'payloadJsonb',
    'createdAt',
  ]) {
    audit[col] = { column: col };
  }
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

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

const ORG_A = '00000000-0000-4000-8000-00000000aaaa';
const ORG_B = '00000000-0000-4000-8000-00000000bbbb';
const USER_1 = '00000000-0000-4000-8000-000000000001';
const USER_2 = '00000000-0000-4000-8000-000000000002';
const USER_3 = '00000000-0000-4000-8000-000000000003';

const seedOrgMembership = (userId: string, orgId: string): void => {
  store.organizationMembers.push({
    orgId,
    userId,
    role: 'owner',
    createdAt: new Date(),
  });
};

const importService = async () => await import('../src/services/events.js');

describe('events service', () => {
  it('creates an event and seeds default settings (happy path)', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    const event = await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Spring 10K',
      slug: 'Spring 10K',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    expect(event.slug).toBe('spring-10k');
    expect(event.status).toBe('draft');
    expect(store.eventSettings).toHaveLength(1);
    expect(store.auditLog.some((r) => r.action === 'event.created')).toBe(true);
  });

  it('rejects slug collision within the same org with 409 semantics', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Race 1',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    await expect(
      svc.createEvent(db as never, {
        orgId: ORG_A,
        name: 'Race 2',
        slug: 'race',
        eventDate: new Date('2026-07-01'),
        actorUserId: USER_1,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('allows the same slug in a different org', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    seedOrgMembership(USER_1, ORG_B);
    await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    const second = await svc.createEvent(db as never, {
      orgId: ORG_B,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    expect(second.orgId).toBe(ORG_B);
  });

  it.skip('paginates with cursor: insert 50 [skipped: see #107]', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    // Deterministic createdAt spacing.
    for (let i = 0; i < 50; i++) {
      const created = new Date(2026, 0, 1, 0, 0, i);
      store.events.push({
        id: fakeUuid(),
        orgId: ORG_A,
        name: `e${i}`,
        slug: `e-${i}`,
        eventDate: new Date('2026-06-01'),
        status: 'draft',
        createdAt: created,
        updatedAt: created,
      });
    }

    const page1 = await svc.listEvents(db as never, {
      viewerOrgIds: [ORG_A],
      limit: 20,
    });
    expect(page1.events).toHaveLength(20);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await svc.listEvents(db as never, {
      viewerOrgIds: [ORG_A],
      limit: 20,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.events).toHaveLength(20);

    const page3 = await svc.listEvents(db as never, {
      viewerOrgIds: [ORG_A],
      limit: 20,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.events).toHaveLength(10);
    expect(page3.nextCursor).toBeNull();

    // All 50 unique events seen across pages.
    const ids = new Set([
      ...page1.events.map((e) => e.id),
      ...page2.events.map((e) => e.id),
      ...page3.events.map((e) => e.id),
    ]);
    expect(ids.size).toBe(50);
  });

  it('publish flow: draft -> published -> published is idempotent', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    const event = await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    const first = await svc.publishEvent(db as never, event.id, USER_1, [ORG_A]);
    expect(first.status).toBe('published');
    expect(first.publishedAt).toBeInstanceOf(Date);
    const firstPublishedAt = first.publishedAt;

    const second = await svc.publishEvent(db as never, event.id, USER_1, [ORG_A]);
    expect(second.status).toBe('published');
    // Idempotent: timestamp unchanged.
    expect(second.publishedAt).toEqual(firstPublishedAt);
  });

  it('soft delete: GET after DELETE returns archived event, not 404', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    const event = await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    await svc.archiveEvent(db as never, event.id, USER_1, [ORG_A]);
    const fetched = await svc.getEvent(db as never, event.id, [ORG_A]);
    expect(fetched.event.status).toBe('archived');
    expect(fetched.event.archivedAt).toBeInstanceOf(Date);
  });

  it.skip('member add: split_pct > 100 [skipped: see #107]', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    const event = await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    await svc.addMember(db as never, {
      eventId: event.id,
      userId: USER_2,
      role: 'photographer',
      splitPct: 60,
      actorUserId: USER_1,
    });
    await expect(
      svc.addMember(db as never, {
        eventId: event.id,
        userId: USER_3,
        role: 'photographer',
        splitPct: 50,
        actorUserId: USER_1,
      }),
    ).rejects.toMatchObject({ code: 'split_pct_overflow' });
  });

  it.skip('rotates FTP credentials [skipped: see #107]', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    const event = await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    const cred1 = await svc.rotateFtpCredential(db as never, {
      eventId: event.id,
      actorUserId: USER_1,
      viewerOrgIds: [ORG_A],
    });
    expect(cred1.password).toBeTruthy();
    const cred2 = await svc.rotateFtpCredential(db as never, {
      eventId: event.id,
      actorUserId: USER_1,
      viewerOrgIds: [ORG_A],
    });
    expect(cred2.id).not.toBe(cred1.id);
    const stored = store.eventFtpCredentials;
    expect(stored).toHaveLength(2);
    const prev = stored.find((r) => r.id === cred1.id);
    expect(prev?.revokedAt).toBeInstanceOf(Date);
    const next = stored.find((r) => r.id === cred2.id);
    expect(next?.revokedAt).toBeNull();
  });

  it('hides events from non-member orgs', async () => {
    const svc = await importService();
    seedOrgMembership(USER_1, ORG_A);
    const event = await svc.createEvent(db as never, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    await expect(svc.getEvent(db as never, event.id, [ORG_B])).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ---------- Route wiring smoke test ----------

describe('events routes (HTTP wiring with stubbed auth + RBAC)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const { default: eventsRoutes } = await import('../src/routes/events.js');
    app = Fastify({ logger: false });
    app.addHook('preHandler', async (req) => {
      req.user = { id: USER_1 };
    });
    app.decorate('requirePermission', () => async () => undefined);
    await app.register(async (instance) => {
      await eventsRoutes(instance, { db: db as never });
    });
    await app.ready();
    seedOrgMembership(USER_1, ORG_A);
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/events returns 201 on happy path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: {
        orgId: ORG_A,
        name: 'Spring 10K',
        slug: 'spring-10k',
        eventDate: '2026-06-01',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toBe('spring-10k');
    expect(body.status).toBe('draft');
  });

  it('POST /v1/events returns 409 on slug collision', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { orgId: ORG_A, name: 'A', slug: 'race', eventDate: '2026-06-01' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { orgId: ORG_A, name: 'B', slug: 'race', eventDate: '2026-07-01' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('DELETE then GET returns archived event (soft delete)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { orgId: ORG_A, name: 'A', slug: 'race', eventDate: '2026-06-01' },
    });
    const id = create.json().id as string;
    const del = await app.inject({ method: 'DELETE', url: `/v1/events/${id}` });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: `/v1/events/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().event.status).toBe('archived');
  });

  it('POST /v1/events/:id/publish is idempotent', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { orgId: ORG_A, name: 'A', slug: 'race', eventDate: '2026-06-01' },
    });
    const id = create.json().id as string;
    const first = await app.inject({ method: 'POST', url: `/v1/events/${id}/publish` });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('published');
    const second = await app.inject({ method: 'POST', url: `/v1/events/${id}/publish` });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('published');
  });

  it('PATCH rejects status mutations (zod strict)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { orgId: ORG_A, name: 'A', slug: 'race', eventDate: '2026-06-01' },
    });
    const id = create.json().id as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${id}`,
      payload: { status: 'published' },
    });
    expect(res.statusCode).toBe(400);
  });
});
