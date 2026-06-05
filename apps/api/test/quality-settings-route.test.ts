// F5.5 — quality settings / rejected-list / override route tests (mocked services).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listPhotographerPhotos: vi.fn(),
  getPhotoQuality: vi.fn(),
  getQualitySettings: vi.fn(),
  updateQualitySettings: vi.fn(),
  overrideRejection: vi.fn(),
  getPhotographerStats: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}) }));
vi.mock('../src/services/photo-quality.js', () => ({
  listPhotographerPhotos: h.listPhotographerPhotos,
  getPhotoQuality: h.getPhotoQuality,
}));
vi.mock('../src/services/photographer-quality-settings.js', () => ({
  getQualitySettings: h.getQualitySettings,
  updateQualitySettings: h.updateQualitySettings,
  overrideRejection: h.overrideRejection,
}));
vi.mock('../src/services/photographer-stats.js', () => ({
  getPhotographerStats: h.getPhotographerStats,
}));

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: meRoutes } = await import('../src/routes/me-photographer.js');
  const { default: pqRoutes } = await import('../src/routes/photo-quality.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: { headers: Record<string, unknown>; user?: unknown }) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string') req.user = JSON.parse(raw);
  });
  await app.register(meRoutes, { db: {} as never });
  await app.register(pqRoutes, { db: {} as never });
  await app.ready();
  return app;
};

const PID = '11111111-1111-1111-1111-111111111111';
const asUser = { 'x-test-user': JSON.stringify({ id: 'u1' }) };

let app: FastifyInstance;
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('GET/PATCH /v1/me/photographer/quality-settings', () => {
  it('200 returns current settings', async () => {
    h.getQualitySettings.mockResolvedValue({ enabled: true, threshold: 0.6 });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/photographer/quality-settings',
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, threshold: 0.6 });
  });

  it('401 without a user', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me/photographer/quality-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('200 updates settings', async () => {
    h.updateQualitySettings.mockResolvedValue({ enabled: true, threshold: 0.7 });
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/photographer/quality-settings',
      headers: asUser,
      payload: { enabled: true, threshold: 0.7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ threshold: 0.7 });
  });

  it('400 on an out-of-range threshold', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/photographer/quality-settings',
      headers: asUser,
      payload: { threshold: 2 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on an empty body', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/photographer/quality-settings',
      headers: asUser,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/me/photographer/photos?rejected=true', () => {
  it('passes onlyRejected to the service', async () => {
    h.listPhotographerPhotos.mockResolvedValue({ items: [], nextCursor: null });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/photographer/photos?rejected=true',
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(h.listPhotographerPhotos).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ onlyRejected: true }),
    );
  });
});

describe('POST /v1/photos/:id/override-rejection', () => {
  it('200 when the override succeeds', async () => {
    h.overrideRejection.mockResolvedValue(true);
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/photos/${PID}/override-rejection`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ photoId: PID, autoRejected: false });
  });

  it('404 when not owned / missing', async () => {
    h.overrideRejection.mockResolvedValue(false);
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/photos/${PID}/override-rejection`,
      headers: asUser,
    });
    expect(res.statusCode).toBe(404);
  });

  it('401 without a user', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/v1/photos/${PID}/override-rejection` });
    expect(res.statusCode).toBe(401);
  });
});
