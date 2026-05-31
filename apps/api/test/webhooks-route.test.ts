// F4.11 — webhook route HTTP tests. Service stubbed; RBAC stubbed.

import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  deleteSubscription: vi.fn(),
  listDeliveries: vi.fn(),
  testSubscription: vi.fn(),
}));

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: { webhooks: { webhookSubscriptions: {}, webhookDeliveries: {} } },
}));

vi.mock('../src/services/webhooks.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/webhooks.js')>();
  return {
    ...actual,
    createSubscription: hoisted.createSubscription,
    listSubscriptions: hoisted.listSubscriptions,
    deleteSubscription: hoisted.deleteSubscription,
    listDeliveries: hoisted.listDeliveries,
    testSubscription: hoisted.testSubscription,
  };
});

const ORG = '50000000-1000-4000-8000-000000000001';
const SUB = '50000000-1000-4000-8000-0000000000a1';

const buildApp = async (role = 'admin'): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/webhooks.js');
  const app = Fastify({ logger: false });
  app.decorate(
    'requirePermission',
    () =>
      async (
        req: { user?: { role?: string } },
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
      ) => {
        if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
        if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
          return reply.code(403).send({ error: 'forbidden' });
        }
        return undefined;
      },
  );
  app.addHook('onRequest', async (request) => {
    (request as { user?: unknown }).user = { id: 'u1', role };
  });
  await app.register(routes, { db: {} as never, masterKey: randomBytes(32).toString('base64') });
  await app.ready();
  return app;
};

let app: FastifyInstance;
beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/orgs/:orgId/webhooks/subscriptions', () => {
  it('201 with the subscription + one-time secret', async () => {
    hoisted.createSubscription.mockResolvedValue({
      subscription: {
        id: SUB,
        targetUrl: 'https://x.io',
        eventTypes: ['order.paid'],
        enabled: true,
        disabledReason: null,
        createdAt: '2026-05-31T00:00:00Z',
      },
      secret: 'deadbeef',
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/webhooks/subscriptions`,
      headers: { 'content-type': 'application/json' },
      payload: { targetUrl: 'https://x.io', eventTypes: ['order.paid'] },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { secret: string }).secret).toBe('deadbeef');
  });

  it('422 when the target url is rejected by the SSRF guard', async () => {
    const { WebhookError } = await import('../src/services/webhooks.js');
    hoisted.createSubscription.mockRejectedValue(new WebhookError('invalid_url', 'blocked'));
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/webhooks/subscriptions`,
      headers: { 'content-type': 'application/json' },
      payload: { targetUrl: 'https://x.io', eventTypes: ['order.paid'] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('400 on an unknown event type (schema rejects)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/webhooks/subscriptions`,
      headers: { 'content-type': 'application/json' },
      payload: { targetUrl: 'https://x.io', eventTypes: ['bogus'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 for a non-admin role', async () => {
    app = await buildApp('attendee');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/webhooks/subscriptions`,
      headers: { 'content-type': 'application/json' },
      payload: { targetUrl: 'https://x.io', eventTypes: ['order.paid'] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('subscription management', () => {
  it('GET lists subscriptions', async () => {
    hoisted.listSubscriptions.mockResolvedValue([{ id: SUB }]);
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${ORG}/webhooks/subscriptions` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('DELETE soft-disables (204)', async () => {
    hoisted.deleteSubscription.mockResolvedValue(undefined);
    app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${ORG}/webhooks/subscriptions/${SUB}`,
    });
    expect(res.statusCode).toBe(204);
  });

  it('GET deliveries 404s for an unknown subscription', async () => {
    const { WebhookError } = await import('../src/services/webhooks.js');
    hoisted.listDeliveries.mockRejectedValue(new WebhookError('not_found', 'nope'));
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${ORG}/webhooks/subscriptions/${SUB}/deliveries`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST test returns 202 with an event id', async () => {
    hoisted.testSubscription.mockResolvedValue({ eventId: 'ev-test' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/webhooks/subscriptions/${SUB}/test`,
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { eventId: string }).eventId).toBe('ev-test');
  });
});
