// F4.12 — notification route HTTP tests. Service stubbed; RBAC stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  selectNotifiable: vi.fn(),
  resendForParticipant: vi.fn(),
  listForEmail: vi.fn(),
}));

// importOriginal loads the real service, which destructures these at module load.
vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    participants: { participants: {} },
    timing: { finishEvents: {} },
    search: { bibTags: {} },
    notifications: { participantNotifications: {}, notificationSuppressions: {} },
    events: { events: {} },
  },
}));
vi.mock('../src/services/notifications.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/notifications.js')>();
  return {
    ...actual,
    selectNotifiable: hoisted.selectNotifiable,
    resendForParticipant: hoisted.resendForParticipant,
    listForEmail: hoisted.listForEmail,
  };
});

const EV = '80000000-1000-4000-8000-000000000001';
const PT = '80000000-1000-4000-8000-0000000000a1';

const buildApp = async (user?: object): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/notifications.js');
  const app = Fastify({ logger: false });
  app.decorate('requirePermission', () => async () => undefined);
  app.addHook('onRequest', async (request) => {
    if (user) (request as { user?: unknown }).user = user;
  });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
beforeEach(() => {
  hoisted.selectNotifiable.mockReset();
  hoisted.resendForParticipant.mockReset();
  hoisted.listForEmail.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/events/:id/notifications/preview', () => {
  it('200 returns a count + coarse participant list (no raw contact info)', async () => {
    hoisted.selectNotifiable.mockResolvedValue([
      {
        participantId: 'p1',
        bib: '101',
        matchedPhotos: 3,
        email: 'secret@x.io',
        phone: '+1',
        smsOptIn: false,
      },
    ]);
    app = await buildApp({ id: 'u1', role: 'organizer' });
    const res = await app.inject({ method: 'POST', url: `/v1/events/${EV}/notifications/preview` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { count: number; participants: Array<{ hasEmail: boolean }> };
    expect(body.count).toBe(1);
    expect(body.participants[0]?.hasEmail).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret@x.io');
  });
});

describe('POST /v1/participants/:id/notifications/resend', () => {
  it('202 with enqueue totals', async () => {
    hoisted.resendForParticipant.mockResolvedValue({ enqueued: 1, skipped: 0, suppressed: 0 });
    app = await buildApp({ id: 'u1', role: 'organizer' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/participants/${PT}/notifications/resend`,
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { enqueued: number }).enqueued).toBe(1);
  });

  it('404 when the participant is unknown', async () => {
    const { NotificationError } = await import('../src/services/notifications.js');
    hoisted.resendForParticipant.mockRejectedValue(new NotificationError('not_found', 'nope'));
    app = await buildApp({ id: 'u1', role: 'organizer' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/participants/${PT}/notifications/resend`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/notifications/me', () => {
  it('401 when unauthenticated', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/notifications/me' });
    expect(res.statusCode).toBe(401);
  });

  it('200 with the caller history matched by email', async () => {
    hoisted.listForEmail.mockResolvedValue([{ channel: 'email', status: 'sent' }]);
    app = await buildApp({ id: 'u1', email: 'me@x.io' });
    const res = await app.inject({ method: 'GET', url: '/v1/notifications/me' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(hoisted.listForEmail).toHaveBeenCalledWith(expect.anything(), 'me@x.io');
  });
});
