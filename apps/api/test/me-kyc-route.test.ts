// F2.9 — me-kyc route HTTP tests. Connect service is stubbed; the route's job
// is auth gating + error mapping.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  startOnboarding: vi.fn(),
  getKycStatus: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

// Fully stub the connect service (incl. a self-contained error class) so the
// real module — which reads schema.payouts at load — is never imported.
vi.mock('../src/services/connect.js', () => {
  class ConnectServiceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ConnectServiceError,
    startOnboarding: hoisted.startOnboarding,
    getKycStatus: hoisted.getKycStatus,
  };
});

process.env.APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://test.local';

interface FakeUser {
  id: string;
  role: string;
}

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: meKycRoutes } = await import('../src/routes/me-kyc.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: { headers: Record<string, unknown>; user?: FakeUser }) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string' && raw.length > 0) req.user = JSON.parse(raw) as FakeUser;
  });
  await app.register(meKycRoutes, { db: {} as never, stripe: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
const asUser = JSON.stringify({ id: 'photog-1', role: 'photographer' });

beforeEach(() => {
  hoisted.startOnboarding.mockReset();
  hoisted.getKycStatus.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/me/kyc/start', () => {
  it('returns 200 with the onboarding link', async () => {
    hoisted.startOnboarding.mockResolvedValue({
      onboardingUrl: 'https://connect.stripe.com/x',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/kyc/start',
      headers: { 'x-test-user': asUser, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ onboardingUrl: 'https://connect.stripe.com/x' });
  });

  it('returns 401 when unauthenticated', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/me/kyc/start', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/me/kyc/status', () => {
  it('returns 200 with status', async () => {
    hoisted.getKycStatus.mockResolvedValue({
      status: 'active',
      chargesEnabled: true,
      payoutsEnabled: true,
      currentlyDue: [],
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/kyc/status',
      headers: { 'x-test-user': asUser },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payoutsEnabled: true });
  });

  it('returns 401 when unauthenticated', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me/kyc/status' });
    expect(res.statusCode).toBe(401);
  });
});
