// F2.10 — admin view of an order's computed revenue split.
//
// GET /v1/admin/orders/:id/splits  — RBAC admin:override.
// Returns the balanced ledger batch the splitter would post for the order plus
// the fee breakdown. Read-only; does not write to the ledger.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../../lib/db.js';
import { computeOrderSplit } from '../../services/order-split.js';

const idParamSchema = z.object({ id: z.string().uuid() });

export interface AdminOrderSplitsOptions {
  db?: DbClient;
}

const adminOrderSplitsRoutes = async (
  app: FastifyInstance,
  opts: AdminOrderSplitsOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.get(
    '/v1/admin/orders/:id/splits',
    { preHandler: app.requirePermission('admin:override') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'invalid order id' });
      }

      try {
        const result = await computeOrderSplit(db, params.data.id);
        return reply.code(200).send({
          entries: result.entries.map((entry) => ({
            account_id: entry.accountId,
            kind: entry.kind,
            direction: entry.direction,
            amount_cents: entry.amountCents,
          })),
          total_cents: result.totalCents,
          platform_fee_cents: result.platformFeeCents,
          stripe_fee_cents: result.stripeFeeCents,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          return reply.code(404).send({ error: 'not_found' });
        }
        request.log.error({ err }, 'order split computation failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );
};

export default adminOrderSplitsRoutes;
