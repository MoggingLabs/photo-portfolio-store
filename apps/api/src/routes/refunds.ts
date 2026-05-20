// F2.6 — Buyer self-service refund request routes.
//
// POST /v1/orders/:id/refund-request
//   Authenticated buyer creates a pending refund request. Rate-limited to
//   1 request per order per 10 minutes per caller to prevent hammering.
//
// GET /v1/orders/:id
//   Authenticated buyer retrieves their order including any active refund
//   request. Returns 404 for unknown orders and for orders the caller does
//   not own (anti-enumeration).
//
// Auth strategy: requires request.user (set by the upstream auth plugin).
// Guest order access via token is not supported on these routes; guests must
// create an account to file a refund. This matches the RBAC contract where
// `commerce:read_orders` is a buyer-authed permission.

import rateLimit from '@fastify/rate-limit';
import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import {
  RefundServiceError,
  createRefundRequest,
  getOrderWithRefund,
} from '../services/refunds.js';

// ---------- Schemas ----------

const orderParamSchema = z.object({ id: z.string().uuid() });

const refundBodySchema = z.object({
  reason: z.string().min(1).max(2000),
  requestedItems: z.array(z.string().uuid()).optional(),
});

// ---------- HTTP error mapping ----------

const mapRefundError = (
  reply: import('fastify').FastifyReply,
  err: RefundServiceError,
): import('fastify').FastifyReply => {
  switch (err.code) {
    case 'order_not_found':
    case 'not_owner':
      // Anti-enumeration: do not reveal whether the order exists.
      return reply.code(404).send({ error: 'not_found' });
    case 'refund_window_expired':
      return reply.code(422).send({ error: 'REFUND_WINDOW_EXPIRED', message: err.message });
    case 'refund_already_requested':
      return reply.code(409).send({ error: 'REFUND_ALREADY_REQUESTED', message: err.message });
    case 'invalid_request':
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    default:
      return reply.code(500).send({ error: 'server_error' });
  }
};

// ---------- Plugin ----------

export interface RefundRoutesOptions {
  db?: DbClient;
  /** Override now() for tests. */
  now?: () => Date;
}

const refundRoutes = async (
  app: FastifyInstance,
  opts: RefundRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---------- POST /v1/orders/:id/refund-request ----------
  // Rate limit scoped to this sub-plugin: max 3 requests per order+user per
  // 10 minutes. Keyed on orderId + caller identity to prevent order-agnostic
  // flooding while keeping the limit meaningful per order.
  await app.register(async (sub) => {
    await sub.register(rateLimit, {
      max: 3,
      timeWindow: '10 minutes',
      keyGenerator: (req: FastifyRequest) => {
        const params = req.params as Record<string, string>;
        const orderId = params.id ?? 'unknown';
        const userId = req.user?.id ?? req.ip;
        return `refund:${orderId}:${userId}`;
      },
      allowList: () => false,
    });

    sub.post('/v1/orders/:id/refund-request', async (request, reply) => {
      if (!request.user?.id) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
      }

      const params = orderParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const body = refundBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          details: body.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }

      try {
        const result = await createRefundRequest(
          db,
          {
            orderId: params.data.id,
            reason: body.data.reason,
            requestedItems: body.data.requestedItems,
          },
          { userId: request.user.id },
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof RefundServiceError) return mapRefundError(reply, err);
        request.log.error({ err }, 'refund request failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    });
  }, {});

  // ---------- GET /v1/orders/:id ----------

  app.get('/v1/orders/:id', async (request, reply) => {
    if (!request.user?.id) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const params = orderParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(404).send({ error: 'not_found' });
    }

    try {
      const order = await getOrderWithRefund(db, params.data.id, { userId: request.user.id });
      if (!order) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send({ order });
    } catch (err) {
      request.log.error({ err }, 'get order failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default refundRoutes;
