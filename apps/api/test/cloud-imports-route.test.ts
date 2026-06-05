// F4.4 — cloud-import route tests (mocked services; RBAC stubbed).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  buildConnectUrl: vi.fn(),
  completeConnection: vi.fn(),
  createCloudImport: vi.fn(),
  getCloudImportProgress: vi.fn(),
}));

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    cloudImports: { cloudImports: {} },
    integrations: { integrationConfigs: {} },
    events: { events: {} },
  },
}));

vi.mock('../src/services/cloud-oauth.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/cloud-oauth.js')>();
  return {
    ...actual,
    buildConnectUrl: hoisted.buildConnectUrl,
    completeConnection: hoisted.completeConnection,
  };
});

vi.mock('../src/services/cloud-imports.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/cloud-imports.js')>();
  return {
    ...actual,
    createCloudImport: hoisted.createCloudImport,
    getCloudImportProgress: hoisted.getCloudImportProgress,
  };
});

import { CloudImportError } from '../src/services/cloud-imports.js';

const EV = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const IMP = '33333333-3333-3333-3333-333333333333';
const cfg = {
  clientId: 'cid',
  clientSecret: 'sec',
  redirectUri: 'https://api.test/v1/integrations/gdrive/callback',
  stateSecret: 'st',
  masterKey: 'mk',
  appBaseUrl: 'https://app.test',
};

const buildApp = async (overrides: Record<string, unknown> = {}): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/cloud-imports.js');
  const app = Fastify({ logger: false });
  app.decorate('requirePermission', () => async () => undefined);
  app.addHook('onRequest', async (req: { headers: Record<string, unknown>; user?: unknown }) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string') req.user = JSON.parse(raw);
  });
  await app.register(routes, {
    db: {} as never,
    oauthConfig: () => cfg,
    httpClient: vi.fn(),
    ...overrides,
  });
  await app.ready();
  return app;
};

const asUser = { 'x-test-user': JSON.stringify({ id: 'u1', role: 'organizer' }) };

let app: FastifyInstance;
beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/orgs/:orgId/integrations/:provider/connect', () => {
  it('200 returns the provider authorize URL', async () => {
    hoisted.buildConnectUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/integrations/gdrive/connect`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authorizeUrl: expect.stringContaining('oauth2') });
  });

  it('503 when the provider is not configured', async () => {
    app = await buildApp({ oauthConfig: () => null });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/integrations/dropbox/connect`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(503);
  });

  it('404 for an unknown provider', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG}/integrations/onedrive/connect`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/integrations/:provider/callback', () => {
  it('302 to the app on a successful connection', async () => {
    hoisted.completeConnection.mockResolvedValue({ orgId: ORG });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/gdrive/callback?code=abc&state=xyz',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('status=connected');
  });

  it('302 error when code/state are missing (no exchange attempted)', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/gdrive/callback' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('status=error');
    expect(hoisted.completeConnection).not.toHaveBeenCalled();
  });

  it('302 error when the exchange/state verification fails', async () => {
    hoisted.completeConnection.mockRejectedValue(new Error('bad state'));
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/gdrive/callback?code=abc&state=bad',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('status=error');
  });
});

describe('POST /v1/events/:id/imports', () => {
  it('201 with the new import id', async () => {
    hoisted.createCloudImport.mockResolvedValue({ importId: IMP, status: 'pending' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/imports`,
      headers: asUser,
      payload: { provider: 'gdrive', remoteFolderId: 'folder-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ importId: IMP, status: 'pending' });
  });

  it('409 when the provider is not connected', async () => {
    hoisted.createCloudImport.mockRejectedValue(new CloudImportError('not_connected', 'x'));
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/imports`,
      headers: asUser,
      payload: { provider: 'gdrive', remoteFolderId: 'folder-1' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('400 when remoteFolderId is missing', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/imports`,
      headers: asUser,
      payload: { provider: 'gdrive' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/events/:id/imports/:importId', () => {
  it('200 with progress', async () => {
    hoisted.getCloudImportProgress.mockResolvedValue({
      id: IMP,
      status: 'running',
      importedFiles: 3,
      totalFiles: 10,
      etaSeconds: 42,
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EV}/imports/${IMP}`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'running', etaSeconds: 42 });
  });

  it('404 when the import is not found in the event', async () => {
    hoisted.getCloudImportProgress.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EV}/imports/${IMP}`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(404);
  });
});
