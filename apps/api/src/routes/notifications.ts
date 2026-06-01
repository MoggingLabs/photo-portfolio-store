// F4.12 — notification operator + participant routes.
//
// POST /v1/events/:id/notifications/preview   — operator: who would be notified now.
// POST /v1/participants/:id/notifications/resend — operator re-trigger (rate-limited).
// GET  /v1/notifications/me                   — participant history (by caller email).

import rateLimit from '@fastify/rate-limit';
import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import {
  NotificationError,
  listForEmail,
  resendForParticipant,
  selectNotifiable,
} from '../services/notifications.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const eventResource = (req: FastifyRequest): { kind: 'event'; id: string } | undefined => {
  const parsed = idParamSchema.safeParse(req.params);
  return parsed.success ? { kind: 'event', id: parsed.data.id } : undefined;
};

export interface NotificationRoutesOptions {
  db?: DbClient;
}

const notificationRoutes = async (
  app: FastifyInstance,
  opts: NotificationRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.post(
    '/v1/events/:id/notifications/preview',
    { preHandler: app.requirePermission('event:write', { resource: eventResource }) },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const candidates = await selectNotifiable(db, params.data.id);
      return reply.code(200).send({
        count: candidates.length,
        // Operator preview — withhold raw email/phone; show coarse readiness.
        participants: candidates.map((c) => ({
          participantId: c.participantId,
          bib: c.bib,
          matchedPhotos: c.matchedPhotos,
          hasEmail: !!c.email,
          smsOptIn: c.smsOptIn,
        })),
      });
    },
  );

  app.register(async (sub) => {
    await sub.register(rateLimit, {
      max: 10,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.user?.id ?? req.ip,
      allowList: () => false,
    });
    sub.post(
      '/v1/participants/:id/notifications/resend',
      { preHandler: sub.requirePermission('event:write') },
      async (request, reply) => {
        const params = idParamSchema.safeParse(request.params);
        if (!params.success) return reply.code(404).send({ error: 'not_found' });
        try {
          const result = await resendForParticipant(db, params.data.id);
          return reply.code(202).send(result);
        } catch (err) {
          if (err instanceof NotificationError) return reply.code(404).send({ error: 'not_found' });
          request.log.error({ err }, 'notification resend failed');
          return reply.code(500).send({ error: 'server_error' });
        }
      },
    );
  });

  // Participant-facing history; owner = authenticated user (matched by email).
  app.get('/v1/notifications/me', async (request, reply) => {
    const email = request.user?.email;
    if (!request.user?.id) return reply.code(401).send({ error: 'unauthorized' });
    if (!email) return reply.code(200).send({ items: [] });
    const items = await listForEmail(db, email);
    return reply.code(200).send({ items });
  });
};

export default notificationRoutes;
