// F4.10 — order fulfillment views (owner-gated, like the other /v1/orders/:id
// routes; RBAC-exempt with an in-handler ownership check).
//
// GET  /v1/orders/:id/fulfillment        — lab order state + tracking.
// POST /v1/orders/:id/fulfillment/poll   — nudge a re-poll (worker re-checks).

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { FulfillmentError, getFulfillment, requestPoll } from '../services/print-fulfillment.js';

const idParamSchema = z.object({ id: z.string().uuid() });

export interface OrderFulfillmentOptions {
  db?: DbClient;
}

const orderFulfillmentRoutes = async (
  app: FastifyInstance,
  opts: OrderFulfillmentOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.get('/v1/orders/:id/fulfillment', async (request, reply) => {
    if (!request.user?.id) return reply.code(401).send({ error: 'unauthorized' });
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    try {
      const view = await getFulfillment(db, params.data.id, request.user.id);
      return reply.code(200).send(view);
    } catch (err) {
      if (err instanceof FulfillmentError) return reply.code(404).send({ error: 'not_found' });
      request.log.error({ err }, 'get fulfillment failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  app.post('/v1/orders/:id/fulfillment/poll', async (request, reply) => {
    if (!request.user?.id) return reply.code(401).send({ error: 'unauthorized' });
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    try {
      const result = await requestPoll(db, params.data.id, request.user.id);
      return reply.code(202).send(result);
    } catch (err) {
      if (err instanceof FulfillmentError) return reply.code(404).send({ error: 'not_found' });
      request.log.error({ err }, 'fulfillment poll failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default orderFulfillmentRoutes;
