// F4.11 — outbound webhook subscription routes (org-scoped, integrations:manage).
//
// POST   /v1/orgs/:orgId/webhooks/subscriptions            — create (secret shown once).
// GET    /v1/orgs/:orgId/webhooks/subscriptions            — list (no secrets).
// DELETE /v1/orgs/:orgId/webhooks/subscriptions/:id        — soft-disable.
// GET    /v1/orgs/:orgId/webhooks/subscriptions/:id/deliveries — recent attempts.
// POST   /v1/orgs/:orgId/webhooks/subscriptions/:id/test   — fire a synthetic event.

import rateLimit from '@fastify/rate-limit';
import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { getIntegrationsMasterKey } from '../lib/integrations-env.js';
import {
  SUBSCRIBABLE_EVENT_TYPES,
  WebhookError,
  createSubscription,
  deleteSubscription,
  listDeliveries,
  listSubscriptions,
  testSubscription,
} from '../services/webhooks.js';

const orgParamSchema = z.object({ orgId: z.string().uuid() });
const subParamSchema = z.object({ orgId: z.string().uuid(), id: z.string().uuid() });
const createBodySchema = z
  .object({
    targetUrl: z.string().url().max(2000),
    eventTypes: z.array(z.enum(SUBSCRIBABLE_EVENT_TYPES)).min(1).max(20),
  })
  .strict();

const orgResource = (req: FastifyRequest) => {
  const parsed = orgParamSchema.safeParse(req.params);
  return { kind: 'org', id: parsed.success ? parsed.data.orgId : '__invalid__' } as const;
};

export interface WebhookRoutesOptions {
  db?: DbClient;
  masterKey?: string;
  allowHttp?: boolean;
}

const webhookRoutes = async (
  app: FastifyInstance,
  opts: WebhookRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const masterKey = (): string => opts.masterKey ?? getIntegrationsMasterKey();
  // HTTP target URLs allowed only outside production (local dev receivers).
  const allowHttp = opts.allowHttp ?? process.env.NODE_ENV !== 'production';

  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.user?.id ?? req.ip,
    allowList: () => false,
  });

  const perm = () => app.requirePermission('integrations:manage', { resource: orgResource });

  app.post(
    '/v1/orgs/:orgId/webhooks/subscriptions',
    { preHandler: perm() },
    async (request, reply) => {
      const params = orgParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      const body = createBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      try {
        const result = await createSubscription(db, params.data.orgId, body.data, {
          masterKey: masterKey(),
          allowHttp,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof WebhookError) {
          const code = err.code === 'invalid_url' ? 422 : 400;
          return reply.code(code).send({ error: err.code, message: err.message });
        }
        request.log.error({ err }, 'webhook subscription create failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  app.get(
    '/v1/orgs/:orgId/webhooks/subscriptions',
    { preHandler: perm() },
    async (request, reply) => {
      const params = orgParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      const items = await listSubscriptions(db, params.data.orgId);
      return reply.code(200).send({ items });
    },
  );

  app.delete(
    '/v1/orgs/:orgId/webhooks/subscriptions/:id',
    { preHandler: perm() },
    async (request, reply) => {
      const params = subParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      await deleteSubscription(db, params.data.orgId, params.data.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/orgs/:orgId/webhooks/subscriptions/:id/deliveries',
    { preHandler: perm() },
    async (request, reply) => {
      const params = subParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      try {
        const items = await listDeliveries(db, params.data.orgId, params.data.id);
        return reply.code(200).send({ items });
      } catch (err) {
        if (err instanceof WebhookError && err.code === 'not_found') {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );

  app.post(
    '/v1/orgs/:orgId/webhooks/subscriptions/:id/test',
    { preHandler: perm(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = subParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      try {
        const result = await testSubscription(db, params.data.orgId, params.data.id);
        return reply.code(202).send(result);
      } catch (err) {
        if (err instanceof WebhookError && err.code === 'not_found') {
          return reply.code(404).send({ error: 'not_found' });
        }
        request.log.error({ err }, 'webhook test failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );
};

export default webhookRoutes;
