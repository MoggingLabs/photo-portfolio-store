// F4.12 — internal notification dispatch trigger.
//
// POST /v1/internal/notifications/run — machine-to-machine, secret-gated (not
// RBAC). Called by the worker cron to enqueue "photos are ready" notifications
// for every event that has finish events. Mirrors the payout internal trigger.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';

import { db as defaultDb } from '../../lib/db.js';
import { enqueueActive } from '../../services/notifications.js';

export interface InternalNotificationsOptions {
  db?: DbClient;
}

const internalNotificationsRoutes = async (
  app: FastifyInstance,
  opts: InternalNotificationsOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.post('/v1/internal/notifications/run', async (request, reply) => {
    const secret = process.env.INTERNAL_CRON_SECRET;
    if (!secret) return reply.code(503).send({ error: 'disabled' });
    if (request.headers['x-internal-secret'] !== secret) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const result = await enqueueActive(db);
    return reply.code(200).send({ result });
  });
};

export default internalNotificationsRoutes;
