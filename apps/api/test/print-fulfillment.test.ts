// F4.10 — print fulfillment API service tests (fake db).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    print: {
      printLabOrders: {
        id: { column: 'id' },
        orderId: { column: 'orderId' },
        labCode: { column: 'labCode' },
        labOrderId: { column: 'labOrderId' },
        idempotencyKey: { column: 'idempotencyKey' },
        state: { column: 'state' },
        trackingCarrier: { column: 'trackingCarrier' },
        trackingNumber: { column: 'trackingNumber' },
        trackingUrl: { column: 'trackingUrl' },
        needsManualIntervention: { column: 'needsManualIntervention' },
        lastStatusAt: { column: 'lastStatusAt' },
        nextRetryAt: { column: 'nextRetryAt' },
      },
      printLabWebhookEvents: {
        id: { column: 'id' },
        labCode: { column: 'labCode' },
        webhookId: { column: 'webhookId' },
        signatureValid: { column: 'signatureValid' },
        processedAt: { column: 'processedAt' },
        payloadJson: { column: 'payloadJson' },
      },
    },
    commerce: { orders: { id: { column: 'id' }, buyerUserId: { column: 'buyerUserId' } } },
  },
}));

vi.mock('drizzle-orm', () => {
  type F = { column: string };
  const isF = (v: unknown): v is F => typeof v === 'object' && v !== null && 'column' in (v as F);
  const val = (v: unknown, r: Record<string, unknown>) => (isF(v) ? r[v.column] : v);
  return {
    and:
      (...p: Array<(r: Record<string, unknown>) => boolean>) =>
      (r: Record<string, unknown>) =>
        p.every((f) => f(r)),
    eq: (a: unknown, b: unknown) => (r: Record<string, unknown>) => val(a, r) === val(b, r),
  };
});

type Row = Record<string, unknown>;
let labOrders: Row[];
let webhookEvents: Row[];
let ordersTbl: Row[];
let seq: number;

const makeDb = () => {
  const buckets = (t: { __b?: string }): Row[] =>
    t.__b === 'events' ? webhookEvents : t.__b === 'orders' ? ordersTbl : labOrders;
  const select = (sel: Record<string, { column: string }>) => {
    const filters: Array<(r: Row) => boolean> = [];
    let bucket: Row[] = [];
    const api = {
      from: (t: { __b?: string }) => {
        bucket = buckets(t);
        return api;
      },
      where: (p: (r: Row) => boolean) => {
        filters.push(p);
        return api;
      },
      limit: () => Promise.resolve(project()),
      then: (resolve: (v: Row[]) => unknown) => resolve(project()),
    };
    const project = () =>
      bucket
        .filter((r) => filters.every((f) => f(r)))
        .map((r) => {
          const o: Row = {};
          for (const [a, ref] of Object.entries(sel)) o[a] = r[ref.column];
          return o;
        });
    return api;
  };
  const insert = (t: { __b?: string }) => ({
    values: (v: Row) => {
      const bucket = buckets(t);
      const isWebhook = t.__b === 'events';
      const dupe =
        isWebhook &&
        webhookEvents.some((e) => e.labCode === v.labCode && e.webhookId === v.webhookId);
      const dupeLab =
        !isWebhook &&
        t.__b !== 'orders' &&
        labOrders.some((o) => o.labCode === v.labCode && o.idempotencyKey === v.idempotencyKey);
      return {
        onConflictDoNothing: () => ({
          returning: () => {
            if (dupe || dupeLab) return Promise.resolve([]);
            const id = `id${seq++}`;
            bucket.push({ ...v, id });
            return Promise.resolve([{ id }]);
          },
        }),
      };
    },
  });
  const update = (t: { __b?: string }) => ({
    set: (s: Row) => ({
      where: (p: (r: Row) => boolean) => {
        const bucket = buckets(t);
        const hit = bucket.filter((r) => p(r));
        for (const r of hit) Object.assign(r, s);
        return { returning: () => Promise.resolve(hit.map((r) => ({ id: r.id }))) };
      },
    }),
  });
  return { select, insert, update } as never;
};

let svc: typeof import('../src/services/print-fulfillment.js');

beforeEach(async () => {
  labOrders = [];
  webhookEvents = [];
  ordersTbl = [];
  seq = 1;
  const { schema } = await import('@pkg/db');
  (schema.print.printLabOrders as { __b?: string }).__b = 'lab';
  (schema.print.printLabWebhookEvents as { __b?: string }).__b = 'events';
  (schema.commerce.orders as { __b?: string }).__b = 'orders';
  svc = await import('../src/services/print-fulfillment.js');
});

describe('createPrintLabOrder', () => {
  it('is idempotent on (lab_code, order id)', async () => {
    const db = makeDb();
    const a = await svc.createPrintLabOrder(db, {
      orderId: 'o1',
      labCode: 'bayphoto',
      printOrder: { x: 1 },
    });
    const b = await svc.createPrintLabOrder(db, {
      orderId: 'o1',
      labCode: 'bayphoto',
      printOrder: { x: 1 },
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(labOrders).toHaveLength(1);
  });
});

describe('getFulfillment / requestPoll ownership', () => {
  it('throws not_found when the caller does not own the order', async () => {
    const db = makeDb();
    ordersTbl.push({ id: 'o1', buyerUserId: 'someone-else' });
    await expect(svc.getFulfillment(db, 'o1', 'u1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns lab orders for the owner', async () => {
    const db = makeDb();
    ordersTbl.push({ id: 'o1', buyerUserId: 'u1' });
    labOrders.push({
      id: 'l1',
      orderId: 'o1',
      labCode: 'bayphoto',
      labOrderId: 'bp1',
      state: 'shipped',
      trackingCarrier: 'UPS',
      trackingNumber: '1Z',
      trackingUrl: 'https://t',
      needsManualIntervention: false,
      lastStatusAt: new Date('2026-06-01T00:00:00Z'),
    });
    const view = await svc.getFulfillment(db, 'o1', 'u1');
    expect(view.labOrders[0]?.tracking?.carrier).toBe('UPS');
  });

  it('requestPoll nudges next_retry_at for the owner', async () => {
    const db = makeDb();
    ordersTbl.push({ id: 'o1', buyerUserId: 'u1' });
    labOrders.push({ id: 'l1', orderId: 'o1', state: 'submitted', nextRetryAt: null });
    const res = await svc.requestPoll(db, 'o1', 'u1');
    expect(res.requeued).toBe(1);
    expect(labOrders[0]?.nextRetryAt).toBeInstanceOf(Date);
  });
});

describe('applyWebhookEvent', () => {
  const evt = (over = {}) => ({
    labCode: 'bayphoto',
    webhookId: 'wh1',
    labOrderId: 'bp1',
    status: 'shipped',
    tracking: { carrier: 'FedEx', number: '99', url: 'https://t' },
    signatureValid: true,
    ...over,
  });

  it('applies a new, valid event and updates state + tracking', async () => {
    const db = makeDb();
    labOrders.push({ id: 'l1', labCode: 'bayphoto', labOrderId: 'bp1', state: 'submitted' });
    const res = await svc.applyWebhookEvent(db, evt(), { any: 'payload' });
    expect(res.processed).toBe(true);
    expect(res.newState).toBe('shipped');
    expect(labOrders[0]?.state).toBe('shipped');
    expect(labOrders[0]?.trackingCarrier).toBe('FedEx');
    expect(webhookEvents[0]?.processedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a duplicate (lab, webhook_id) is skipped', async () => {
    const db = makeDb();
    labOrders.push({ id: 'l1', labCode: 'bayphoto', labOrderId: 'bp1', state: 'submitted' });
    await svc.applyWebhookEvent(db, evt(), {});
    const res = await svc.applyWebhookEvent(db, evt(), {});
    expect(res.processed).toBe(false);
    expect(res.reason).toBe('duplicate');
    expect(webhookEvents).toHaveLength(1);
  });

  it('records but does not apply an invalid-signature event', async () => {
    const db = makeDb();
    labOrders.push({ id: 'l1', labCode: 'bayphoto', labOrderId: 'bp1', state: 'submitted' });
    const res = await svc.applyWebhookEvent(db, evt({ signatureValid: false }), {});
    expect(res.processed).toBe(false);
    expect(res.reason).toBe('invalid_signature');
    expect(labOrders[0]?.state).toBe('submitted');
  });
});
