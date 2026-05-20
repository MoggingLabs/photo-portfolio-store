// F2.6 — Refund request service + routes tests.
//
// Mirrors the consents.test.ts pattern: in-memory store, TABLE_KEY routing,
// drizzle-orm shim, and Fastify inject for route-level cases.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory store ----------

type Row = Record<string, unknown>;

interface Store {
  orders: Row[];
  refundRequests: Row[];
  auditLog: Row[];
}

const newStore = (): Store => ({ orders: [], refundRequests: [], auditLog: [] });

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store): Row => {
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

// ---------- Module mocks ----------

vi.mock('@pkg/db', () => {
  const commerceTbl = {
    orders: tableMarker('orders'),
    refundRequests: tableMarker('refundRequests'),
  };
  const complianceTbl = {
    auditLog: tableMarker('auditLog'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      commerce: {
        tables: commerceTbl,
        ...commerceTbl,
      },
      compliance: {
        tables: complianceTbl,
        auditLog: complianceTbl.auditLog,
      },
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
    string: () => ({ min: () => ({}) }),
  },
}));

// Capture sendMail calls.
const sendMailMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/lib/email.js', () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));

// Capture writeAudit calls via the real module but intercept the db insert.
// We let writeAudit call db.insert which is handled by our fake db below.

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
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));

  return { eq, and, inArray, sql: () => () => true };
});

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.commerce.tables.orders as Record<string, unknown>, [
    'id',
    'buyerUserId',
    'buyerEmail',
    'paidAt',
    'placedAt',
    'status',
    'subtotalCents',
    'taxCents',
    'totalCents',
    'currency',
  ]);
  tag(schema.commerce.tables.refundRequests as Record<string, unknown>, [
    'id',
    'orderId',
    'buyerId',
    'reason',
    'requestedItems',
    'status',
    'adminNote',
    'createdAt',
    'updatedAt',
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
    'payloadHash',
    'ipHash',
    'userAgent',
  ]);
};

// ---------- Fake DB ----------

let store: Store;

const makeFakeDb = (opts: { throwUniqueOnInsert?: boolean } = {}) => {
  const selectBuilder = (selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        if (!bucket) return resolve([]);
        let rows: Row[] = store[bucket].map((r) => ({ ...r }));
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
        if (opts.throwUniqueOnInsert && bucket === 'refundRequests') {
          const e = new Error('duplicate key value violates unique constraint') as Error & {
            code: string;
          };
          e.code = '23505';
          throw e;
        }
        const arr = Array.isArray(payload) ? payload : [payload];
        inserted = arr.map((row) => ({
          id: fakeUuid(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...row,
        }));
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

  return {
    select: (s?: Record<string, unknown>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
  };
};

// ---------- Lifecycle ----------

const ORDER_ID = '10000000-1000-4000-8000-000000000001';
const USER_ID = '20000000-2000-4000-8000-000000000002';
const BUYER_EMAIL = 'buyer@example.com';
const FUTURE_PAID_AT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
const ANCIENT_PAID_AT = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago

const seedOrder = (overrides: Partial<Row> = {}): void => {
  store.orders.push({
    id: ORDER_ID,
    buyerUserId: USER_ID,
    buyerEmail: BUYER_EMAIL,
    subtotalCents: 1000,
    taxCents: 100,
    totalCents: 1100,
    currency: 'usd',
    status: 'paid',
    placedAt: FUTURE_PAID_AT,
    paidAt: FUTURE_PAID_AT,
    ...overrides,
  });
};

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  sendMailMock.mockClear();
  await installFieldShims();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------- Service tests ----------

describe('createRefundRequest', () => {
  it('happy path: creates pending row, writes audit, fires notification once', async () => {
    seedOrder();
    const db = makeFakeDb();
    const { createRefundRequest } = await import('../src/services/refunds.js');

    const result = await createRefundRequest(
      db as never,
      { orderId: ORDER_ID, reason: 'Item damaged' },
      { userId: USER_ID },
    );

    expect(result.status).toBe('pending');
    expect(result.refundRequestId).toBeTruthy();
    expect(result.createdAt).toBeTruthy();

    expect(store.refundRequests).toHaveLength(1);
    expect(store.refundRequests[0]).toMatchObject({
      orderId: ORDER_ID,
      reason: 'Item damaged',
      status: 'pending',
    });

    expect(store.auditLog.some((r) => r.action === 'order.refund.requested')).toBe(true);

    // Notification fired exactly once.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0]?.[0]).toMatchObject({
      subject: expect.stringContaining('Refund Request'),
    });
  });

  it('returns order_not_found when order is missing', async () => {
    const db = makeFakeDb();
    const { createRefundRequest, RefundServiceError } = await import('../src/services/refunds.js');

    await expect(
      createRefundRequest(db as never, { orderId: ORDER_ID, reason: 'test' }, { userId: USER_ID }),
    ).rejects.toMatchObject({ code: 'order_not_found' } as Partial<
      InstanceType<typeof RefundServiceError>
    >);
  });

  it('returns not_owner when userId does not match buyerUserId', async () => {
    seedOrder();
    const db = makeFakeDb();
    const { createRefundRequest, RefundServiceError } = await import('../src/services/refunds.js');

    await expect(
      createRefundRequest(
        db as never,
        { orderId: ORDER_ID, reason: 'test' },
        { userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      ),
    ).rejects.toMatchObject({ code: 'not_owner' } as Partial<
      InstanceType<typeof RefundServiceError>
    >);
  });

  it('returns refund_window_expired when paidAt is over 30 days ago', async () => {
    seedOrder({ paidAt: ANCIENT_PAID_AT, placedAt: ANCIENT_PAID_AT });
    const db = makeFakeDb();
    const { createRefundRequest, RefundServiceError } = await import('../src/services/refunds.js');

    await expect(
      createRefundRequest(db as never, { orderId: ORDER_ID, reason: 'test' }, { userId: USER_ID }),
    ).rejects.toMatchObject({ code: 'refund_window_expired' } as Partial<
      InstanceType<typeof RefundServiceError>
    >);
  });

  it('returns refund_already_requested when an active request exists (pre-check path)', async () => {
    seedOrder();
    store.refundRequests.push({
      id: fakeUuid(),
      orderId: ORDER_ID,
      buyerId: USER_ID,
      reason: 'First request',
      status: 'pending',
      requestedItems: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = makeFakeDb();
    const { createRefundRequest, RefundServiceError } = await import('../src/services/refunds.js');

    await expect(
      createRefundRequest(
        db as never,
        { orderId: ORDER_ID, reason: 'Second attempt' },
        { userId: USER_ID },
      ),
    ).rejects.toMatchObject({ code: 'refund_already_requested' } as Partial<
      InstanceType<typeof RefundServiceError>
    >);
  });

  it('returns refund_already_requested when unique-violation is caught on insert (race path)', async () => {
    seedOrder();
    // Fake db will throw a unique violation on insert.
    const db = makeFakeDb({ throwUniqueOnInsert: true });
    const { createRefundRequest, RefundServiceError } = await import('../src/services/refunds.js');

    await expect(
      createRefundRequest(db as never, { orderId: ORDER_ID, reason: 'test' }, { userId: USER_ID }),
    ).rejects.toMatchObject({ code: 'refund_already_requested' } as Partial<
      InstanceType<typeof RefundServiceError>
    >);
  });

  it('guest ownership via buyerEmail', async () => {
    seedOrder({ buyerUserId: null });
    const db = makeFakeDb();
    const { createRefundRequest } = await import('../src/services/refunds.js');

    const result = await createRefundRequest(
      db as never,
      { orderId: ORDER_ID, reason: 'Damaged' },
      { buyerEmail: BUYER_EMAIL },
    );
    expect(result.status).toBe('pending');
  });
});

describe('getOrderWithRefund', () => {
  it('returns order with null refundRequest when none exists', async () => {
    seedOrder();
    const db = makeFakeDb();
    const { getOrderWithRefund } = await import('../src/services/refunds.js');

    const view = await getOrderWithRefund(db as never, ORDER_ID, { userId: USER_ID });
    expect(view).not.toBeNull();
    expect(view?.refundRequest).toBeNull();
    expect(view?.id).toBe(ORDER_ID);
  });

  it('attaches refundRequest when an active one exists', async () => {
    seedOrder();
    const rrId = fakeUuid();
    store.refundRequests.push({
      id: rrId,
      orderId: ORDER_ID,
      buyerId: USER_ID,
      reason: 'Broken item',
      status: 'pending',
      requestedItems: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = makeFakeDb();
    const { getOrderWithRefund } = await import('../src/services/refunds.js');

    const view = await getOrderWithRefund(db as never, ORDER_ID, { userId: USER_ID });
    expect(view?.refundRequest).not.toBeNull();
    expect(view?.refundRequest?.id).toBe(rrId);
    expect(view?.refundRequest?.status).toBe('pending');
    expect(view?.refundRequest?.reason).toBe('Broken item');
  });

  it('returns null when caller does not own the order', async () => {
    seedOrder();
    const db = makeFakeDb();
    const { getOrderWithRefund } = await import('../src/services/refunds.js');

    const view = await getOrderWithRefund(db as never, ORDER_ID, {
      userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    expect(view).toBeNull();
  });

  it('returns null when order is missing', async () => {
    const db = makeFakeDb();
    const { getOrderWithRefund } = await import('../src/services/refunds.js');

    const view = await getOrderWithRefund(db as never, ORDER_ID, { userId: USER_ID });
    expect(view).toBeNull();
  });
});

// ---------- Route tests ----------

const buildApp = async (
  db: ReturnType<typeof makeFakeDb>,
  userId?: string,
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  // Simulate the auth plugin decorating request.user.
  app.decorateRequest('user', null);
  if (userId) {
    app.addHook('onRequest', async (req) => {
      (req as import('fastify').FastifyRequest & { user?: { id: string; role: string } }).user = {
        id: userId,
        role: 'buyer',
      };
    });
  }

  const { default: refundRoutes } = await import('../src/routes/refunds.js');
  await app.register(refundRoutes, { db: db as never });
  return app;
};

describe('POST /v1/orders/:id/refund-request', () => {
  it('happy path: 201 with refundRequestId, status, createdAt', async () => {
    seedOrder();
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: { reason: 'Item arrived broken' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { refundRequestId: string; status: string; createdAt: string };
    expect(body.status).toBe('pending');
    expect(body.refundRequestId).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
    // Notification fired exactly once.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns 401 when unauthenticated', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db); // no userId -> no user decoration

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: { reason: 'Test' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when reason exceeds 2000 chars', async () => {
    seedOrder();
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: { reason: 'x'.repeat(2001) },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when reason is missing', async () => {
    seedOrder();
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 for unknown order (anti-enumeration)', async () => {
    const db = makeFakeDb(); // store is empty
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: { reason: 'Test' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for non-owner (anti-enumeration)', async () => {
    seedOrder();
    const db = makeFakeDb();
    const app = await buildApp(db, 'ffffffff-ffff-4fff-8fff-ffffffffffff');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: { reason: 'Test' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 422 REFUND_WINDOW_EXPIRED when beyond 30 days', async () => {
    seedOrder({ paidAt: ANCIENT_PAID_AT, placedAt: ANCIENT_PAID_AT });
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: { reason: 'Test' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toBe('REFUND_WINDOW_EXPIRED');
    await app.close();
  });

  it('returns 409 REFUND_ALREADY_REQUESTED when duplicate active request', async () => {
    seedOrder();
    store.refundRequests.push({
      id: fakeUuid(),
      orderId: ORDER_ID,
      buyerId: USER_ID,
      reason: 'Existing',
      status: 'pending',
      requestedItems: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orders/${ORDER_ID}/refund-request`,
      payload: { reason: 'Duplicate' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('REFUND_ALREADY_REQUESTED');
    await app.close();
  });
});

describe('GET /v1/orders/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db);

    const res = await app.inject({ method: 'GET', url: `/v1/orders/${ORDER_ID}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 404 for unknown order', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({ method: 'GET', url: `/v1/orders/${ORDER_ID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for non-owner (anti-enumeration)', async () => {
    seedOrder();
    const db = makeFakeDb();
    const app = await buildApp(db, 'ffffffff-ffff-4fff-8fff-ffffffffffff');

    const res = await app.inject({ method: 'GET', url: `/v1/orders/${ORDER_ID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns order with null refundRequest when none exists', async () => {
    seedOrder();
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({ method: 'GET', url: `/v1/orders/${ORDER_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ order: { id: string; refundRequest: null } }>();
    expect(body.order.id).toBe(ORDER_ID);
    expect(body.order.refundRequest).toBeNull();
    await app.close();
  });

  it('returns order with refundRequest when one is active', async () => {
    seedOrder();
    const rrId = fakeUuid();
    store.refundRequests.push({
      id: rrId,
      orderId: ORDER_ID,
      buyerId: USER_ID,
      reason: 'Damaged',
      status: 'pending',
      requestedItems: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = makeFakeDb();
    const app = await buildApp(db, USER_ID);

    const res = await app.inject({ method: 'GET', url: `/v1/orders/${ORDER_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ order: { refundRequest: { id: string; status: string } | null } }>();
    expect(body.order.refundRequest).not.toBeNull();
    expect(body.order.refundRequest?.id).toBe(rrId);
    expect(body.order.refundRequest?.status).toBe('pending');
    await app.close();
  });
});
