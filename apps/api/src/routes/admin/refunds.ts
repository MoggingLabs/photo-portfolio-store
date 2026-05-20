// F2.7 — admin refund decision endpoint.
//
// POST /v1/admin/refund-requests/:id/decision  — RBAC admin:override.
// Approve (Stripe refund + balanced reversal ledger) or deny (notify buyer).

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../../lib/db.js';
import {
  AdminRefundError,
  type MailerFn,
  type RefundDecisionInput,
  type StripeRefundClient,
  decideRefund,
} from '../../services/admin-refunds.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const decisionBodySchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    amountCents: z.number().int().positive().optional(),
    adminNote: z.string().max(2000).optional(),
  })
  .strict();

const mapError = (reply: import('fastify').FastifyReply, err: AdminRefundError) => {
  switch (err.code) {
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'already_decided':
      return reply.code(409).send({ error: 'already_decided', message: err.message });
    case 'invalid_amount':
    case 'invalid_decision':
    case 'no_charge':
      return reply.code(422).send({ error: err.code, message: err.message });
    case 'stripe_error':
      return reply.code(502).send({ error: 'stripe_error', message: err.message });
    default:
      return reply.code(500).send({ error: 'server_error' });
  }
};

export interface AdminRefundsOptions {
  db?: DbClient;
  stripe?: StripeRefundClient;
  mailer?: MailerFn;
}

const adminRefundsRoutes = async (
  app: FastifyInstance,
  opts: AdminRefundsOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.post(
    '/v1/admin/refund-requests/:id/decision',
    { preHandler: app.requirePermission('admin:override') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body = decisionBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          details: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const adminUserId = request.user?.id;
      if (!adminUserId) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      try {
        const input: RefundDecisionInput = body.data;
        const result = await decideRefund(
          db,
          params.data.id,
          input,
          { adminUserId },
          opts.stripe,
          opts.mailer,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof AdminRefundError) return mapError(reply, err);
        request.log.error({ err }, 'refund decision failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );
};

export default adminRefundsRoutes;
