// F4.6+ — timing provider binding routes (event-scoped, event:write).
//
// POST /v1/events/:id/integrations/:provider        — bind race + save API key.
// POST /v1/events/:id/integrations/:provider/sync   — request a sync.
// GET  /v1/events/:id/integrations/timing           — list bindings (no secrets).

import type { DbClient } from '@pkg/db';
import { TIMING_PROVIDERS, isTimingProvider } from '@pkg/integrations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { getIntegrationsMasterKey } from '../lib/integrations-env.js';
import {
  TimingBindingError,
  bindTimingProvider,
  listBindings,
  requestSync,
} from '../services/timing.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const providerParamSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(TIMING_PROVIDERS),
});
const bindBodySchema = z
  .object({
    externalEventId: z.string().min(1).max(200),
    apiKey: z.string().min(1).max(2000),
  })
  .strict();

const eventResource = (req: FastifyRequest): { kind: 'event'; id: string } | undefined => {
  const parsed = idParamSchema.safeParse(req.params);
  return parsed.success ? { kind: 'event', id: parsed.data.id } : undefined;
};

export interface TimingRoutesOptions {
  db?: DbClient;
  masterKey?: string;
}

const timingRoutes = async (
  app: FastifyInstance,
  opts: TimingRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const masterKey = (): string => opts.masterKey ?? getIntegrationsMasterKey();
  const perm = () => app.requirePermission('event:write', { resource: eventResource });

  app.post(
    '/v1/events/:id/integrations/:provider',
    { preHandler: perm() },
    async (request, reply) => {
      const params = providerParamSchema.safeParse(request.params);
      if (!params.success || !isTimingProvider(params.data.provider)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body = bindBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      const view = await bindTimingProvider(
        db,
        {
          eventId: params.data.id,
          provider: params.data.provider,
          externalEventId: body.data.externalEventId,
          apiKey: body.data.apiKey,
        },
        { masterKey: masterKey() },
      );
      return reply.code(200).send(view);
    },
  );

  app.post(
    '/v1/events/:id/integrations/:provider/sync',
    { preHandler: perm() },
    async (request, reply) => {
      const params = providerParamSchema.safeParse(request.params);
      if (!params.success || !isTimingProvider(params.data.provider)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      try {
        const result = await requestSync(db, params.data.id, params.data.provider);
        return reply.code(202).send(result);
      } catch (err) {
        if (err instanceof TimingBindingError && err.code === 'not_found') {
          return reply.code(404).send({ error: 'not_found' });
        }
        request.log.error({ err }, 'timing sync request failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  app.get('/v1/events/:id/integrations/timing', { preHandler: perm() }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const items = await listBindings(db, params.data.id);
    return reply.code(200).send({ items });
  });
};

export default timingRoutes;
