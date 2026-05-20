// F2.10 — admin order-splits route HTTP tests. computeOrderSplit is stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ computeOrderSplit: vi.fn() }));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));
vi.mock('../src/services/order-split.js', () => ({ computeOrderSplit: hoisted.computeOrderSplit }));

interface FakeUser {
  id: string;
  role: string;
}

const ORDER_ID = '10000000-1000-4000-8000-000000000001';

const buildApp = async (role = 'admin'): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/admin/order-splits.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: { headers: Record<string, unknown>; user?: FakeUser }) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string') req.user = JSON.parse(raw) as FakeUser;
  });
  app.decorate('requirePermission', () => async (req: { user?: FakeUser }, reply: never) => {
    const user = (req as { user?: FakeUser }).user;
    const r = reply as unknown as { code: (n: number) => { send: (b: unknown) => unknown } };
    if (!user) return r.code(401).send({ error: 'Unauthorized' });
    if (user.role !== 'admin') return r.code(403).send({ error: 'Forbidden' });
    return undefined;
  });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
const adminUser = JSON.stringify({ id: 'a1', role: 'admin' });

beforeEach(() => hoisted.computeOrderSplit.mockReset());
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/admin/orders/:id/splits', () => {
  it('returns 200 with the split breakdown', async () => {
    hoisted.computeOrderSplit.mockResolvedValue({
      entries: [
        {
          accountId: 'platform:platform_cash',
          kind: 'sale',
          direction: 'debit',
          amountCents: 10000,
        },
        { accountId: 'photog:A', kind: 'sale', direction: 'credit', amountCents: 8680 },
      ],
      totalCents: 10000,
      platformFeeCents: 1000,
      stripeFeeCents: 320,
      photographerNetByUserId: { A: 8680 },
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/orders/${ORDER_ID}/splits`,
      headers: { 'x-test-user': adminUser },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total_cents: number; entries: unknown[] };
    expect(body.total_cents).toBe(10000);
    expect(body.entries).toHaveLength(2);
  });

  it('returns 403 for a non-admin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/orders/${ORDER_ID}/splits`,
      headers: { 'x-test-user': JSON.stringify({ id: 'u', role: 'photographer' }) },
    });
    expect(res.statusCode).toBe(403);
  });
});
