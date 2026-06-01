// F4.10 — order fulfillment route tests (owner-gated; service stubbed).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getFulfillment: vi.fn(), requestPoll: vi.fn() }));

// schema.print/commerce must exist: importOriginal loads the real service.
vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    print: { printLabOrders: {}, printLabWebhookEvents: {} },
    commerce: { orders: {} },
  },
}));
vi.mock('../src/services/print-fulfillment.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/print-fulfillment.js')>();
  return { ...actual, getFulfillment: hoisted.getFulfillment, requestPoll: hoisted.requestPoll };
});

const ORD = '60000000-1000-4000-8000-000000000001';

const buildApp = async (user?: object): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/order-fulfillment.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    if (user) (request as { user?: unknown }).user = user;
  });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
beforeEach(() => {
  hoisted.getFulfillment.mockReset();
  hoisted.requestPoll.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/orders/:id/fulfillment', () => {
  it('401 when unauthenticated', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/orders/${ORD}/fulfillment` });
    expect(res.statusCode).toBe(401);
  });

  it('404 when the service reports not-owned/not-found', async () => {
    const { FulfillmentError } = await import('../src/services/print-fulfillment.js');
    hoisted.getFulfillment.mockRejectedValue(new FulfillmentError('not_found', 'nope'));
    app = await buildApp({ id: 'u1' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orders/${ORD}/fulfillment`,
      headers: { 'x-test': '1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 with the fulfillment view', async () => {
    hoisted.getFulfillment.mockResolvedValue({ orderId: ORD, labOrders: [] });
    app = await buildApp({ id: 'u1' });
    const res = await app.inject({ method: 'GET', url: `/v1/orders/${ORD}/fulfillment` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { orderId: string }).orderId).toBe(ORD);
  });
});

describe('POST /v1/orders/:id/fulfillment/poll', () => {
  it('202 with requeue count', async () => {
    hoisted.requestPoll.mockResolvedValue({ requeued: 2 });
    app = await buildApp({ id: 'u1' });
    const res = await app.inject({ method: 'POST', url: `/v1/orders/${ORD}/fulfillment/poll` });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { requeued: number }).requeued).toBe(2);
  });
});
