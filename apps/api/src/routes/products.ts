// Products HTTP routes. Thin layer over services/products.ts — every handler
// validates input with zod, delegates to a service function, and translates
// ProductServiceError into Fastify HTTP errors.
//
// Auth and RBAC decorators are expected to be wired by upstream plugins:
//   - request.user.id    (set by auth plugin)
//   - app.requirePermission(permission, { resource })  (set by RBAC plugin)
// Tests stub these via vitest mocks.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Permission } from '../auth/permissions.js';
import { db as defaultDb } from '../lib/db.js';
import {
  ProductServiceError,
  createProduct,
  deactivateProduct,
  getLicenseTierByCode,
  getProduct,
  getProductEvent,
  listProducts,
  updateProduct,
} from '../services/products.js';

// ---------- Schemas ----------

const uuidSchema = z.string().uuid();

const productKindSchema = z.enum(['digital_single', 'digital_bundle', 'foto_flat', 'print']);
const licenseTierCodeSchema = z.enum(['personal', 'social', 'editorial', 'commercial']);

const listQuerySchema = z.object({
  kind: productKindSchema.optional(),
  active: z.coerce.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const createBodySchema = z
  .object({
    photoId: uuidSchema,
    licenseTierCode: licenseTierCodeSchema,
    name: z.string().min(1).max(200),
    priceCents: z.number().int().min(0).max(100_000_000),
    currency: z.string().length(3).optional(),
    description: z.string().max(4000).optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    priceCents: z.number().int().min(0).max(100_000_000).optional(),
    currency: z.string().length(3).optional(),
    description: z.string().max(4000).nullable().optional(),
    licenseTierCode: licenseTierCodeSchema.optional(),
    // Explicitly reject mutations of immutable fields. zod .strict() also
    // catches unknown keys, but listing these by name gives a cleaner 400.
    kind: z.never().optional(),
    eventId: z.never().optional(),
    sku: z.never().optional(),
  })
  .strict();

const eventIdParamsSchema = z.object({ eventId: uuidSchema });
const productIdParamsSchema = z.object({ productId: uuidSchema });

// ---------- Helpers ----------

const handleServiceError = (reply: FastifyReply, err: unknown): FastifyReply => {
  if (err instanceof ProductServiceError) {
    switch (err.code) {
      case 'not_found':
        return reply.code(404).send({ error: err.message });
      case 'conflict':
        return reply.code(409).send({ error: err.message });
      case 'forbidden':
        return reply.code(403).send({ error: err.message });
      case 'unprocessable':
        return reply.code(422).send({ error: err.message });
      case 'invalid':
        return reply.code(400).send({ error: err.message });
    }
  }
  throw err;
};

const requireUser = (request: FastifyRequest): { id: string } => {
  if (!request.user?.id) {
    const err = new Error('unauthenticated');
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }
  return request.user;
};

const requirePerm = (
  app: FastifyInstance,
  permission: Permission,
  resourceResolver?: (req: FastifyRequest) => { kind: 'event'; id: string } | undefined,
) => {
  if (typeof app.requirePermission === 'function') {
    return app.requirePermission(
      permission,
      resourceResolver ? { resource: resourceResolver } : {},
    );
  }
  return async (): Promise<void> => undefined;
};

// ---------- Plugin ----------

export interface ProductsRoutesOptions {
  db?: DbClient;
}

const productsRoutes = async (
  app: FastifyInstance,
  opts: ProductsRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---- GET /v1/events/:eventId/products ----
  app.get(
    '/v1/events/:eventId/products',
    {
      preHandler: requirePerm(app, 'event:read', (req) => {
        const parsed = eventIdParamsSchema.safeParse(req.params);
        return parsed.success ? { kind: 'event', id: parsed.data.eventId } : undefined;
      }),
      schema: {
        params: {
          type: 'object',
          required: ['eventId'],
          properties: { eventId: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['digital_single', 'digital_bundle', 'foto_flat', 'print'],
            },
            active: { type: 'boolean' },
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      requireUser(request);
      const params = eventIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid eventId' });
      }
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid query', issues: query.error.issues });
      }
      try {
        const result = await listProducts(db, {
          eventId: params.data.eventId,
          kind: query.data.kind,
          active: query.data.active,
          cursor: query.data.cursor,
          limit: query.data.limit,
        });
        return reply.send({ products: result.products, nextCursor: result.nextCursor });
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- POST /v1/events/:eventId/products ----
  app.post(
    '/v1/events/:eventId/products',
    {
      preHandler: requirePerm(app, 'event:write', (req) => {
        const parsed = eventIdParamsSchema.safeParse(req.params);
        return parsed.success ? { kind: 'event', id: parsed.data.eventId } : undefined;
      }),
      schema: {
        params: {
          type: 'object',
          required: ['eventId'],
          properties: { eventId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['photoId', 'licenseTierCode', 'name', 'priceCents'],
          properties: {
            photoId: { type: 'string', format: 'uuid' },
            licenseTierCode: {
              type: 'string',
              enum: ['personal', 'social', 'editorial', 'commercial'],
            },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            priceCents: { type: 'integer', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            description: { type: 'string', maxLength: 4000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const params = eventIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid eventId' });
      }
      const body = createBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
      }

      // Resolve the license tier code -> id.
      const tier = await getLicenseTierByCode(db, body.data.licenseTierCode);
      if (!tier) {
        return reply
          .code(422)
          .send({ error: `license tier '${body.data.licenseTierCode}' not configured` });
      }

      // Pick event currency as default if not provided. Falls through to
      // service-layer validation if neither is sane.
      const eventRow = await getProductEvent(db, params.data.eventId);
      if (!eventRow) {
        return reply.code(404).send({ error: 'event not found' });
      }

      try {
        const product = await createProduct(
          db,
          {
            eventId: params.data.eventId,
            photoId: body.data.photoId,
            licenseTierId: tier.id,
            name: body.data.name,
            priceCents: body.data.priceCents,
            currency: (body.data.currency ?? 'USD').toUpperCase(),
            description: body.data.description,
          },
          user.id,
        );
        return reply.code(201).send(product);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- GET /v1/products/:productId ----
  //
  // Public if the underlying event is published AND the product is active.
  // Otherwise requires event:read on the product's event. We do the auth
  // gating inside the handler because permission depends on the row state.
  app.get(
    '/v1/products/:productId',
    {
      preHandler: requirePerm(app, 'event:read', (req) => {
        const parsed = productIdParamsSchema.safeParse(req.params);
        // Without the product row we cannot resolve the event id here; the
        // RBAC plugin treats a missing resource as a role-only check. The
        // handler enforces the public/private decision below.
        if (!parsed.success) return undefined;
        const stashed = (req as FastifyRequest & { _resolvedEventId?: string })._resolvedEventId;
        return stashed ? { kind: 'event', id: stashed } : undefined;
      }),
      schema: {
        params: {
          type: 'object',
          required: ['productId'],
          properties: { productId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const params = productIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid productId' });
      }
      try {
        const product = await getProduct(db, params.data.productId);
        if (!product) {
          return reply.code(404).send({ error: 'product not found' });
        }
        const eventRow = await getProductEvent(db, product.eventId);
        const isPubliclyVisible =
          product.active && eventRow !== null && eventRow.status === 'published';
        if (!isPubliclyVisible && !request.user) {
          return reply.code(404).send({ error: 'product not found' });
        }
        return reply.send(product);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- PATCH /v1/products/:productId ----
  app.patch(
    '/v1/products/:productId',
    {
      preHandler: requirePerm(app, 'event:write'),
      schema: {
        params: {
          type: 'object',
          required: ['productId'],
          properties: { productId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            priceCents: { type: 'integer', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            description: { type: ['string', 'null'], maxLength: 4000 },
            licenseTierCode: {
              type: 'string',
              enum: ['personal', 'social', 'editorial', 'commercial'],
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const params = productIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid productId' });
      }
      const body = updateBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
      }

      let licenseTierId: string | undefined;
      if (body.data.licenseTierCode) {
        const tier = await getLicenseTierByCode(db, body.data.licenseTierCode);
        if (!tier) {
          return reply
            .code(422)
            .send({ error: `license tier '${body.data.licenseTierCode}' not configured` });
        }
        licenseTierId = tier.id;
      }

      try {
        const product = await updateProduct(
          db,
          params.data.productId,
          {
            name: body.data.name,
            priceCents: body.data.priceCents,
            currency: body.data.currency?.toUpperCase(),
            description: body.data.description,
            licenseTierId,
          },
          user.id,
        );
        return reply.send(product);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- DELETE /v1/products/:productId ----  (soft deactivate)
  app.delete(
    '/v1/products/:productId',
    {
      preHandler: requirePerm(app, 'event:write'),
      schema: {
        params: {
          type: 'object',
          required: ['productId'],
          properties: { productId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const params = productIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid productId' });
      }
      try {
        const product = await deactivateProduct(db, params.data.productId, user.id);
        return reply.send(product);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );
};

export default productsRoutes;
