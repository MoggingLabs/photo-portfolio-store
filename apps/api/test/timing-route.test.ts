// F4.6 — timing route HTTP tests. Service stubbed; RBAC stubbed.

import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  bindTimingProvider: vi.fn(),
  requestSync: vi.fn(),
  listBindings: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: { timing: {} } }));
vi.mock('../src/services/timing.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/timing.js')>();
  return {
    ...actual,
    bindTimingProvider: hoisted.bindTimingProvider,
    requestSync: hoisted.requestSync,
    listBindings: hoisted.listBindings,
  };
});

const EV = '70000000-1000-4000-8000-000000000001';

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/timing.js');
  const app = Fastify({ logger: false });
  app.decorate('requirePermission', () => async () => undefined);
  await app.register(routes, { db: {} as never, masterKey: randomBytes(32).toString('base64') });
  await app.ready();
  return app;
};

let app: FastifyInstance;
beforeEach(() => {
  hoisted.bindTimingProvider.mockReset();
  hoisted.requestSync.mockReset();
  hoisted.listBindings.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/events/:id/integrations/:provider', () => {
  it('200 binds a provider', async () => {
    hoisted.bindTimingProvider.mockResolvedValue({
      provider: 'runsignup',
      externalEventId: 'r1',
      enabled: true,
      lastSyncedAt: null,
      lastError: null,
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/integrations/runsignup`,
      headers: { 'content-type': 'application/json' },
      payload: { externalEventId: 'r1', apiKey: 'k' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { externalEventId: string }).externalEventId).toBe('r1');
  });

  it('404 for an unknown provider', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/integrations/stravatiming`,
      headers: { 'content-type': 'application/json' },
      payload: { externalEventId: 'r1', apiKey: 'k' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 on a missing apiKey', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/integrations/runsignup`,
      headers: { 'content-type': 'application/json' },
      payload: { externalEventId: 'r1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/events/:id/integrations/:provider/sync', () => {
  it('202 requests a sync', async () => {
    hoisted.requestSync.mockResolvedValue({ requested: true });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/integrations/runsignup/sync`,
    });
    expect(res.statusCode).toBe(202);
  });

  it('404 when no binding exists', async () => {
    const { TimingBindingError } = await import('../src/services/timing.js');
    hoisted.requestSync.mockRejectedValue(new TimingBindingError('not_found', 'nope'));
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/integrations/runsignup/sync`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/events/:id/integrations/timing', () => {
  it('200 lists bindings', async () => {
    hoisted.listBindings.mockResolvedValue([{ provider: 'runsignup' }]);
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/events/${EV}/integrations/timing` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1);
  });
});
