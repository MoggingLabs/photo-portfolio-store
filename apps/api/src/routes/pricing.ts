// Pricing HTTP routes. Exposes license-tier multipliers for the storefront.
//
// RBAC MUST NOT gate these routes. Storefront pricing is public — any visitor
// needs to know tier prices before adding items to a cart. This mirrors the
// same anonymous-first decision in cart.ts.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { listTiers } from '../services/pricing-tiers.js';

// ---------- Schemas ----------

const listTiersQuerySchema = z.object({
  eventId: z.string().uuid().optional(),
});

// ---------- Plugin options ----------

export interface PricingRoutesOptions {
  db?: DbClient;
}

// ---------- Plugin ----------

const pricingRoutes = async (
  app: FastifyInstance,
  opts: PricingRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---- GET /v1/pricing/tiers ----
  // Returns all license tiers with their resolved multipliers.
  // Optional ?eventId=<uuid> applies event-scoped pricing rules.
  app.get('/v1/pricing/tiers', async (request, reply) => {
    const query = listTiersQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_query',
        details: query.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    try {
      const tiers = await listTiers(db, { eventId: query.data.eventId });
      return reply.code(200).send({ tiers });
    } catch (err) {
      request.log.error({ err }, 'pricing tiers: failed to list tiers');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default pricingRoutes;
