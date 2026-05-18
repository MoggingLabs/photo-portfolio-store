// Products service + route tests. Same in-memory fake DbClient shape as
// events.test.ts — we mock @pkg/db and drizzle-orm with a tiny store-backed
// builder so the service can run without Postgres.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  products: Row[];
  licenseTiers: Row[];
  photos: Row[];
  events: Row[];
  auditLog: Row[];
}

const newStore = (): Store => ({
  products: [],
  licenseTiers: [],
  photos: [],
  events: [],
  auditLog: [],
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
  const catalogTables = {
    products: tableMarker('products'),
    licenseTiers: tableMarker('licenseTiers'),
  };
  const photoTables = {
    photos: tableMarker('photos'),
    uploadSessions: tableMarker('photos'),
    photoDerivatives: tableMarker('photos'),
  };
  const eventTables = {
    events: tableMarker('events'),
    eventMembers: tableMarker('events'),
    eventSettings: tableMarker('events'),
    eventFtpCredentials: tableMarker('events'),
  };
  const complianceTables = {
    auditLog: tableMarker('auditLog'),
    consents: tableMarker('auditLog'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      catalog: { tables: catalogTables },
      photos: { tables: photoTables },
      events: { tables: eventTables },
      compliance: { tables: complianceTables },
    },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({ min: () => ({}) }),
  },
}));

let store: Store = newStore();

const makeFakeDb = (): unknown => {
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

  const selectBuilder = (_selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let sortFn: ((a: Row, b: Row) => number) | undefined;
    let limitN: number | undefined;

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
        toInsert = arr.map((row) => ({
          id: fakeUuid(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...row,
        }));
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
  const sqlTag = ((strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sql: strings.join(''),
  })) as unknown as Record<string, unknown>;
  sqlTag.join = (_arr: unknown[], _sep: unknown) => ({ __sql: 'joined' });

  return { eq, and, or, gte, lt, ilike, asc, desc, sql: sqlTag };
});

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const productTbl = schema.catalog.tables.products as Record<string, unknown>;
  const tierTbl = schema.catalog.tables.licenseTiers as Record<string, unknown>;
  const photoTbl = schema.photos.tables.photos as Record<string, unknown>;
  const eventTbl = schema.events.tables.events as Record<string, unknown>;
  const audit = schema.compliance.tables.auditLog as Record<string, unknown>;

  for (const col of [
    'id',
    'eventId',
    'kind',
    'sku',
    'name',
    'description',
    'priceCents',
    'currency',
    'licenseTierId',
    'photoId',
    'active',
    'createdAt',
    'updatedAt',
    'configJsonb',
  ]) {
    productTbl[col] = { column: col };
  }
  for (const col of ['id', 'code', 'name', 'description', 'sortOrder']) {
    tierTbl[col] = { column: col };
  }
  for (const col of ['id', 'eventId']) {
    photoTbl[col] = { column: col };
  }
  for (const col of ['id', 'orgId', 'status']) {
    eventTbl[col] = { column: col };
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
  ]) {
    audit[col] = { column: col };
  }
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

const EVENT_A = '00000000-0000-4000-8000-0000000000aa';
const EVENT_B = '00000000-0000-4000-8000-0000000000bb';
const PHOTO_1 = '00000000-0000-4000-8000-000000000111';
const PHOTO_2 = '00000000-0000-4000-8000-000000000222';
const USER_1 = '00000000-0000-4000-8000-000000000001';
const TIER_PERSONAL = '00000000-0000-4000-8000-0000000aaaa1';
const TIER_COMMERCIAL = '00000000-0000-4000-8000-0000000aaaa2';

const seedTiers = (): void => {
  store.licenseTiers.push(
    { id: TIER_PERSONAL, code: 'personal', name: 'Personal use', description: 'x', sortOrder: 1 },
    {
      id: TIER_COMMERCIAL,
      code: 'commercial',
      name: 'Commercial',
      description: 'x',
      sortOrder: 4,
    },
  );
};

const seedPhoto = (id: string, eventId: string): void => {
  store.photos.push({ id, eventId });
};

const seedEvent = (id: string, status = 'published'): void => {
  store.events.push({ id, orgId: 'org-1', status });
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

const importService = async () => await import('../src/services/products.js');

// ---------- Service tests ----------

describe('products service', () => {
  it('creates a digital_single product with a deterministic SKU', async () => {
    const svc = await importService();
    seedTiers();
    seedEvent(EVENT_A);
    seedPhoto(PHOTO_1, EVENT_A);

    const product = await svc.createProduct(
      db as never,
      {
        eventId: EVENT_A,
        photoId: PHOTO_1,
        licenseTierId: TIER_PERSONAL,
        name: 'Race finish photo',
        priceCents: 1500,
        currency: 'USD',
      },
      USER_1,
    );

    expect(product.kind).toBe('digital_single');
    expect(product.sku).toMatch(/^evt-[0-9a-f]{8}-photo-[0-9a-f]{8}-per$/);
    expect(product.priceCents).toBe(1500);
    expect(product.active).toBe(true);
    expect(store.auditLog.some((r) => r.action === 'product.created')).toBe(true);

    // Determinism: identical (event, photo, license) yields identical SKU.
    const sku1 = product.sku;
    store.products = [];
    const second = await svc.createProduct(
      db as never,
      {
        eventId: EVENT_A,
        photoId: PHOTO_1,
        licenseTierId: TIER_PERSONAL,
        name: 'Race finish photo',
        priceCents: 1500,
        currency: 'USD',
      },
      USER_1,
    );
    expect(second.sku).toBe(sku1);
  });

  it('rejects creation when photoId does not exist (422)', async () => {
    const svc = await importService();
    seedTiers();
    seedEvent(EVENT_A);

    await expect(
      svc.createProduct(
        db as never,
        {
          eventId: EVENT_A,
          photoId: PHOTO_1, // never seeded
          licenseTierId: TIER_PERSONAL,
          name: 'X',
          priceCents: 1000,
          currency: 'USD',
        },
        USER_1,
      ),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('rejects creation when the photo belongs to a different event (422)', async () => {
    const svc = await importService();
    seedTiers();
    seedEvent(EVENT_A);
    seedEvent(EVENT_B);
    seedPhoto(PHOTO_1, EVENT_B); // photo belongs to B, not A

    await expect(
      svc.createProduct(
        db as never,
        {
          eventId: EVENT_A,
          photoId: PHOTO_1,
          licenseTierId: TIER_PERSONAL,
          name: 'X',
          priceCents: 1000,
          currency: 'USD',
        },
        USER_1,
      ),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('rejects duplicate (event, photo, kind, license) combo with 409', async () => {
    const svc = await importService();
    seedTiers();
    seedEvent(EVENT_A);
    seedPhoto(PHOTO_1, EVENT_A);

    await svc.createProduct(
      db as never,
      {
        eventId: EVENT_A,
        photoId: PHOTO_1,
        licenseTierId: TIER_PERSONAL,
        name: 'X',
        priceCents: 1000,
        currency: 'USD',
      },
      USER_1,
    );

    await expect(
      svc.createProduct(
        db as never,
        {
          eventId: EVENT_A,
          photoId: PHOTO_1,
          licenseTierId: TIER_PERSONAL,
          name: 'X again',
          priceCents: 2000,
          currency: 'USD',
        },
        USER_1,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lists products filtered by kind', async () => {
    const svc = await importService();
    seedTiers();
    seedEvent(EVENT_A);
    seedPhoto(PHOTO_1, EVENT_A);
    seedPhoto(PHOTO_2, EVENT_A);

    await svc.createProduct(
      db as never,
      {
        eventId: EVENT_A,
        photoId: PHOTO_1,
        licenseTierId: TIER_PERSONAL,
        name: 'A',
        priceCents: 100,
        currency: 'USD',
      },
      USER_1,
    );
    await svc.createProduct(
      db as never,
      {
        eventId: EVENT_A,
        photoId: PHOTO_2,
        licenseTierId: TIER_COMMERCIAL,
        name: 'B',
        priceCents: 999,
        currency: 'USD',
      },
      USER_1,
    );
    // Hand-insert a foto_flat row to make sure filter excludes it.
    store.products.push({
      id: fakeUuid(),
      eventId: EVENT_A,
      kind: 'foto_flat',
      sku: 'evt-x-flat',
      name: 'Flat',
      priceCents: 5000,
      currency: 'USD',
      licenseTierId: TIER_PERSONAL,
      photoId: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const all = await svc.listProducts(db as never, { eventId: EVENT_A });
    expect(all.products.length).toBe(3);

    const digitals = await svc.listProducts(db as never, {
      eventId: EVENT_A,
      kind: 'digital_single',
    });
    expect(digitals.products.length).toBe(2);
    expect(digitals.products.every((p) => p.kind === 'digital_single')).toBe(true);
  });

  it('deactivate flips active=false and keeps the row readable', async () => {
    const svc = await importService();
    seedTiers();
    seedEvent(EVENT_A);
    seedPhoto(PHOTO_1, EVENT_A);

    const product = await svc.createProduct(
      db as never,
      {
        eventId: EVENT_A,
        photoId: PHOTO_1,
        licenseTierId: TIER_PERSONAL,
        name: 'X',
        priceCents: 1000,
        currency: 'USD',
      },
      USER_1,
    );

    const deact = await svc.deactivateProduct(db as never, product.id, USER_1);
    expect(deact.active).toBe(false);

    const fetched = await svc.getProduct(db as never, product.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.active).toBe(false);
    expect(store.auditLog.some((r) => r.action === 'product.deactivated')).toBe(true);
  });

  it('updateProduct can change name / price but never kind or eventId', async () => {
    const svc = await importService();
    seedTiers();
    seedEvent(EVENT_A);
    seedPhoto(PHOTO_1, EVENT_A);

    const product = await svc.createProduct(
      db as never,
      {
        eventId: EVENT_A,
        photoId: PHOTO_1,
        licenseTierId: TIER_PERSONAL,
        name: 'X',
        priceCents: 1000,
        currency: 'USD',
      },
      USER_1,
    );

    const updated = await svc.updateProduct(
      db as never,
      product.id,
      { name: 'Renamed', priceCents: 2500 },
      USER_1,
    );
    expect(updated.name).toBe('Renamed');
    expect(updated.priceCents).toBe(2500);
    expect(updated.kind).toBe('digital_single');
    expect(updated.eventId).toBe(EVENT_A);
  });

  it('seedDefaultLicenseTiers is idempotent', async () => {
    const svc = await importService();
    const first = await svc.seedDefaultLicenseTiers(db as never);
    expect(first).toBe(4);
    expect(store.licenseTiers).toHaveLength(4);

    const second = await svc.seedDefaultLicenseTiers(db as never);
    expect(second).toBe(0);
    expect(store.licenseTiers).toHaveLength(4);
  });
});

// ---------- Route wiring smoke test ----------

describe('products routes (HTTP wiring with stubbed auth + RBAC)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const { default: productsRoutes } = await import('../src/routes/products.js');
    app = Fastify({ logger: false });
    app.addHook('preHandler', async (req) => {
      req.user = { id: USER_1, role: 'admin' as never };
    });
    app.decorate('requirePermission', () => async () => undefined);
    await app.register(async (instance) => {
      await productsRoutes(instance, { db: db as never });
    });
    await app.ready();
    seedTiers();
    seedEvent(EVENT_A);
    seedPhoto(PHOTO_1, EVENT_A);
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/events/:eventId/products returns 201 with a proper SKU', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: PHOTO_1,
        licenseTierCode: 'personal',
        name: 'Test',
        priceCents: 1500,
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.kind).toBe('digital_single');
    expect(body.sku).toMatch(/^evt-[0-9a-f]{8}-photo-[0-9a-f]{8}-per$/);
  });

  it('POST with non-existent photoId returns 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: '00000000-0000-4000-8000-00000000dead',
        licenseTierCode: 'personal',
        name: 'X',
        priceCents: 1000,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('POST with photo from a different event returns 422', async () => {
    seedEvent(EVENT_B);
    seedPhoto(PHOTO_2, EVENT_B);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: PHOTO_2,
        licenseTierCode: 'personal',
        name: 'X',
        priceCents: 1000,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('GET list filters by kind', async () => {
    // Create one product
    await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: PHOTO_1,
        licenseTierCode: 'personal',
        name: 'X',
        priceCents: 1000,
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EVENT_A}/products?kind=digital_single`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products.length).toBe(1);
    expect(body.products[0].kind).toBe('digital_single');
  });

  it('DELETE soft-deactivates and GET still returns the row', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: PHOTO_1,
        licenseTierCode: 'personal',
        name: 'X',
        priceCents: 1000,
      },
    });
    const id = create.json().id as string;
    const del = await app.inject({ method: 'DELETE', url: `/v1/products/${id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().active).toBe(false);

    const get = await app.inject({ method: 'GET', url: `/v1/products/${id}` });
    // Inactive product on a published event is not publicly visible, but
    // the stubbed auth treats this request as authenticated, so we still
    // get 200 with active=false.
    expect(get.statusCode).toBe(200);
    expect(get.json().active).toBe(false);
  });

  it.skip('PATCH rejects mutations of immutable fields [see #107]', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: PHOTO_1,
        licenseTierCode: 'personal',
        name: 'X',
        priceCents: 1000,
      },
    });
    const id = create.json().id as string;

    const res1 = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${id}`,
      payload: { kind: 'foto_flat' },
    });
    expect(res1.statusCode).toBe(400);

    const res2 = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${id}`,
      payload: { eventId: EVENT_B },
    });
    expect(res2.statusCode).toBe(400);
  });

  it('PATCH happy path: rename and re-price', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: PHOTO_1,
        licenseTierCode: 'personal',
        name: 'X',
        priceCents: 1000,
      },
    });
    const id = create.json().id as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${id}`,
      payload: { name: 'Renamed', priceCents: 2500 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('Renamed');
    expect(body.priceCents).toBe(2500);
  });
});
