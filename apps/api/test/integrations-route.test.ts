// F4.1 — integrations route HTTP tests. Service stubbed; RBAC stubbed.

import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  listIntegrations: vi.fn(),
  upsertIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  testIntegration: vi.fn(),
}));

// schema.integrations.integrationConfigs must exist: importOriginal loads the
// real service module, which destructures it at module load.
vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: { integrations: { integrationConfigs: {} } },
}));

vi.mock('../src/services/integrations.js', async (importOriginal) => {
  // Keep the real type list + guards + error class; stub the IO functions.
  const actual = await importOriginal<typeof import('../src/services/integrations.js')>();
  return {
    ...actual,
    listIntegrations: hoisted.listIntegrations,
    upsertIntegration: hoisted.upsertIntegration,
    deleteIntegration: hoisted.deleteIntegration,
    testIntegration: hoisted.testIntegration,
  };
});

const ORG = '30000000-1000-4000-8000-000000000001';

const buildApp = async (opts: { role?: string } = {}): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/integrations.js');
  const app = Fastify({ logger: false });
  // Stub the RBAC decorator: 401 with no user, 403 for the wrong role, else pass.
  app.decorate(
    'requirePermission',
    () =>
      async (
        request: { user?: { role?: string } },
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
      ) => {
        if (!request.user) return reply.code(401).send({ error: 'unauthorized' });
        if (request.user.role !== 'admin' && request.user.role !== 'superadmin') {
          return reply.code(403).send({ error: 'forbidden' });
        }
        return undefined;
      },
  );
  app.addHook('onRequest', async (request) => {
    const raw = request.headers['x-test-user'];
    if (typeof raw === 'string') (request as { user?: unknown }).user = JSON.parse(raw);
  });
  await app.register(routes, { db: {} as never, masterKey: randomBytes(32).toString('base64') });
  await app.ready();
  return app;
};

const admin = { 'x-test-user': JSON.stringify({ id: 'u1', role: 'admin' }) };

let app: FastifyInstance;
beforeEach(() => {
  hoisted.listIntegrations.mockReset();
  hoisted.upsertIntegration.mockReset();
  hoisted.deleteIntegration.mockReset();
  hoisted.testIntegration.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/orgs/:orgId/integrations', () => {
  it('401 without a user', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${ORG}/integrations` });
    expect(res.statusCode).toBe(401);
  });

  it('403 for a non-admin role', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${ORG}/integrations`,
      headers: { 'x-test-user': JSON.stringify({ id: 'u2', role: 'attendee' }) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 with the connector list for an admin', async () => {
    hoisted.listIntegrations.mockResolvedValue([{ type: 'runsignup', configured: false }]);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${ORG}/integrations`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe('PUT /v1/orgs/:orgId/integrations/:type', () => {
  it('404 for an unknown connector type', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${ORG}/integrations/nope`,
      headers: { ...admin, 'content-type': 'application/json' },
      payload: { credentials: 'k' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 and returns status + test result', async () => {
    hoisted.upsertIntegration.mockResolvedValue({
      status: { type: 'runsignup', configured: true, enabled: true },
      test: { ok: true },
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${ORG}/integrations/runsignup`,
      headers: { ...admin, 'content-type': 'application/json' },
      payload: { credentials: 'rsu_key', config: { raceId: '123' } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { test: { ok: boolean } }).test.ok).toBe(true);
  });

  it('400 on an invalid body (unknown field)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${ORG}/integrations/runsignup`,
      headers: { ...admin, 'content-type': 'application/json' },
      payload: { bogus: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v1/orgs/:orgId/integrations/:type', () => {
  it('204 soft-deletes', async () => {
    hoisted.deleteIntegration.mockResolvedValue(undefined);
    app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${ORG}/integrations/dropbox`,
      headers: admin,
    });
    expect(res.statusCode).toBe(204);
    expect(hoisted.deleteIntegration).toHaveBeenCalled();
  });
});

describe('POST /v1/orgs/:orgId/integrations/:type/test', () => {
  it('200 with the test result', async () => {
    hoisted.testIntegration.mockResolvedValue({ ok: false, error: 'connector_not_implemented' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/integrations/mylaps/test`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { error: string }).error).toBe('connector_not_implemented');
  });
});
