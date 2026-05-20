// F2.7 — admin refund decision route HTTP tests. decideRefund is stubbed; the
// real AdminRefundError is kept so the route's instanceof mapping works.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ decideRefund: vi.fn() }));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

// Fully stub the service (incl. a self-contained error class) so the real
// module — which loads ledger.js/stripe.js at import — is never pulled in.
vi.mock('../src/services/admin-refunds.js', () => {
  class AdminRefundError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { AdminRefundError, decideRefund: hoisted.decideRefund };
});

interface FakeUser {
  id: string;
  role: string;
}

const RR_ID = '20000000-2000-4000-8000-000000000002';

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/admin/refunds.js');
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

const post = (payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/v1/admin/refund-requests/${RR_ID}/decision`,
    headers: { 'x-test-user': adminUser, 'content-type': 'application/json' },
    payload,
  });

beforeEach(() => hoisted.decideRefund.mockReset());
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/admin/refund-requests/:id/decision', () => {
  it('returns 200 on approve', async () => {
    hoisted.decideRefund.mockResolvedValue({
      status: 'processed',
      stripeRefundId: 're_1',
      refundedCents: 10000,
    });
    app = await buildApp();
    const res = await post({ decision: 'approve' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed', refundedCents: 10000 });
  });

  it('returns 400 on an invalid body', async () => {
    app = await buildApp();
    const res = await post({ decision: 'maybe' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for a non-admin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/refund-requests/${RR_ID}/decision`,
      headers: {
        'x-test-user': JSON.stringify({ id: 'u', role: 'buyer' }),
        'content-type': 'application/json',
      },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });
});
