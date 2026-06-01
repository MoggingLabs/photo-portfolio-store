// F4.10 — inbound print-lab webhook route tests (real signature, stubbed service).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signWebhookBody } from '@pkg/integrations';

const hoisted = vi.hoisted(() => ({ applyWebhookEvent: vi.fn() }));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: { print: {} } }));
vi.mock('../src/services/print-fulfillment.js', () => ({
  applyWebhookEvent: hoisted.applyWebhookEvent,
}));

const SECRET = 'lab-secret';
const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/print-webhooks.js');
  const app = Fastify({ logger: false });
  await app.register(routes, { db: {} as never, secretResolver: () => SECRET });
  await app.ready();
  return app;
};

const post = (app: FastifyInstance, body: object, opts: { sign?: boolean; ts?: number } = {}) => {
  const raw = JSON.stringify(body);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign !== false) {
    headers['x-webhook-timestamp'] = String(ts);
    headers['x-webhook-signature'] = signWebhookBody(SECRET, ts, raw);
  }
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/print-lab/bayphoto',
    headers,
    payload: raw,
  });
};

let app: FastifyInstance;
beforeEach(() => hoisted.applyWebhookEvent.mockReset());
afterEach(async () => {
  if (app) await app.close();
});

const validBody = { webhook_id: 'wh1', lab_order_id: 'bp1', status: 'shipped' };

describe('POST /v1/webhooks/print-lab/:lab_code', () => {
  it('200 and applies the event when the signature is valid', async () => {
    hoisted.applyWebhookEvent.mockResolvedValue({ processed: true, newState: 'shipped' });
    app = await buildApp();
    const res = await post(app, validBody);
    expect(res.statusCode).toBe(200);
    expect(hoisted.applyWebhookEvent).toHaveBeenCalled();
  });

  it('401 when the signature is missing/invalid', async () => {
    app = await buildApp();
    const res = await post(app, validBody, { sign: false });
    expect(res.statusCode).toBe(401);
    expect(hoisted.applyWebhookEvent).not.toHaveBeenCalled();
  });

  it('401 when the timestamp is outside the replay window', async () => {
    app = await buildApp();
    const res = await post(app, validBody, { ts: Math.floor(Date.now() / 1000) - 1000 });
    expect(res.statusCode).toBe(401);
  });

  it('404 for an unknown lab code', async () => {
    const { default: routes } = await import('../src/routes/print-webhooks.js');
    app = Fastify({ logger: false });
    await app.register(routes, { db: {} as never, secretResolver: () => SECRET });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/print-lab/whcc',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 on a body missing required fields', async () => {
    app = await buildApp();
    const res = await post(app, { webhook_id: 'wh1' });
    expect(res.statusCode).toBe(400);
  });

  it('503 when no secret is configured for the lab', async () => {
    const { default: routes } = await import('../src/routes/print-webhooks.js');
    app = Fastify({ logger: false });
    await app.register(routes, { db: {} as never, secretResolver: () => null });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/print-lab/bayphoto',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(503);
  });
});
