// Events HTTP routes. Thin layer over services/events.ts — every handler
// resolves the viewer's org scope, delegates to a service function, and
// translates EventServiceError instances into Fastify HTTP errors.
//
// Auth and RBAC decorators are expected to be wired by upstream plugins:
//   - request.user.id    (set by auth plugin)
//   - app.requirePermission(permission)  (set by RBAC plugin)
// Tests stub these via vitest mocks.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '../auth/permissions.js';
import { db as defaultDb } from '../lib/db.js';
import {
  EventServiceError,
  addMember,
  archiveEvent,
  createEvent,
  getEvent,
  getViewerOrgIds,
  listEvents,
  publishEvent,
  removeMember,
  rotateFtpCredential,
  updateEvent,
  updateMember,
} from '../services/events.js';

// Fastify decorator types (FastifyRequest.user, FastifyInstance.requirePermission)
// are declared canonically in src/auth/rbac.ts. Do not re-declare here.

// ---------- Schemas ----------

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9\-_ ]*$/, 'slug contains invalid characters');

const uuidSchema = z.string().uuid();

const eventDateSchema = z.coerce.date();

const createEventBodySchema = z.object({
  orgId: uuidSchema,
  name: z.string().min(1).max(200),
  slug: slugSchema,
  eventDate: eventDateSchema,
  location: z.string().max(200).optional(),
  timezone: z.string().max(64).optional(),
  description: z.string().max(4000).optional(),
  retentionDays: z.number().int().positive().max(3650).optional(),
  currency: z.string().length(3).optional(),
});

const updateEventBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: slugSchema.optional(),
    description: z.string().max(4000).nullable().optional(),
    eventDate: eventDateSchema.optional(),
    location: z.string().max(200).nullable().optional(),
    timezone: z.string().max(64).optional(),
    retentionDays: z.number().int().positive().max(3650).optional(),
    currency: z.string().length(3).optional(),
    allowFaceSearch: z.boolean().optional(),
    coverPhotoId: uuidSchema.nullable().optional(),
    // Reject status mutations through PATCH — use /publish or DELETE.
    status: z.never().optional(),
  })
  .strict();

const listEventsQuerySchema = z.object({
  orgId: uuidSchema.optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  after: z.coerce.date().optional(),
  q: z.string().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const memberRoleSchema = z.enum(['organizer', 'photographer', 'assistant']);
const splitPctSchema = z.number().min(0).max(100);

const addMemberBodySchema = z.object({
  userId: uuidSchema,
  role: memberRoleSchema,
  splitPct: splitPctSchema.optional(),
});

const updateMemberBodySchema = z
  .object({
    role: memberRoleSchema.optional(),
    splitPct: splitPctSchema.optional(),
  })
  .refine(
    (v) => v.role !== undefined || v.splitPct !== undefined,
    'at least one of role or splitPct is required',
  );

const idParamsSchema = z.object({ id: uuidSchema });
const idUserParamsSchema = z.object({ id: uuidSchema, userId: uuidSchema });

// ---------- Helpers ----------

const handleServiceError = (reply: FastifyReply, err: unknown): FastifyReply => {
  if (err instanceof EventServiceError) {
    switch (err.code) {
      case 'not_found':
        return reply.code(404).send({ error: err.message });
      case 'conflict':
        return reply.code(409).send({ error: err.message });
      case 'forbidden':
        return reply.code(403).send({ error: err.message });
      case 'split_pct_overflow':
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

const requirePerm = (app: FastifyInstance, permission: Permission) => {
  if (typeof app.requirePermission === 'function') {
    return app.requirePermission(permission);
  }
  // No-op preHandler when RBAC plugin isn't loaded (test contexts stub auth).
  return async (): Promise<void> => undefined;
};

// ---------- Plugin ----------

export interface EventsRoutesOptions {
  // Allow tests to inject a different DB client / mocked services.
  db?: DbClient;
}

const eventsRoutes = async (
  app: FastifyInstance,
  opts: EventsRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---- GET /v1/events ----
  app.get('/v1/events', { preHandler: requirePerm(app, 'event:read') }, async (request, reply) => {
    const user = requireUser(request);
    const parsed = listEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid query', issues: parsed.error.issues });
    }
    const viewerOrgIds = await getViewerOrgIds(db, user.id);
    try {
      const result = await listEvents(db, { ...parsed.data, viewerOrgIds });
      return reply.send({
        events: result.events,
        nextCursor: result.nextCursor,
      });
    } catch (err) {
      return handleServiceError(reply, err);
    }
  });

  // ---- POST /v1/events ----
  app.post(
    '/v1/events',
    { preHandler: requirePerm(app, 'event:write') },
    async (request, reply) => {
      const user = requireUser(request);
      const parsed = createEventBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
      }
      try {
        const event = await createEvent(db, { ...parsed.data, actorUserId: user.id });
        return reply.code(201).send(event);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- GET /v1/events/:id ----
  app.get(
    '/v1/events/:id',
    { preHandler: requirePerm(app, 'event:read') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const viewerOrgIds = await getViewerOrgIds(db, user.id);
      try {
        const result = await getEvent(db, params.data.id, viewerOrgIds);
        return reply.send(result);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- PATCH /v1/events/:id ----
  app.patch(
    '/v1/events/:id',
    { preHandler: requirePerm(app, 'event:write') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const body = updateEventBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
      }
      const viewerOrgIds = await getViewerOrgIds(db, user.id);
      try {
        const event = await updateEvent(db, params.data.id, body.data, user.id, viewerOrgIds);
        return reply.send(event);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- DELETE /v1/events/:id ----  (soft delete -> status='archived')
  app.delete(
    '/v1/events/:id',
    { preHandler: requirePerm(app, 'event:delete') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const viewerOrgIds = await getViewerOrgIds(db, user.id);
      try {
        const event = await archiveEvent(db, params.data.id, user.id, viewerOrgIds);
        return reply.send(event);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- POST /v1/events/:id/publish ----
  app.post(
    '/v1/events/:id/publish',
    { preHandler: requirePerm(app, 'event:publish') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const viewerOrgIds = await getViewerOrgIds(db, user.id);
      try {
        const event = await publishEvent(db, params.data.id, user.id, viewerOrgIds);
        return reply.send(event);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- POST /v1/events/:id/members ----
  app.post(
    '/v1/events/:id/members',
    { preHandler: requirePerm(app, 'event:members:manage') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const body = addMemberBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
      }
      try {
        const member = await addMember(db, {
          eventId: params.data.id,
          userId: body.data.userId,
          role: body.data.role,
          splitPct: body.data.splitPct,
          actorUserId: user.id,
        });
        return reply.code(201).send(member);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- PATCH /v1/events/:id/members/:userId ----
  app.patch(
    '/v1/events/:id/members/:userId',
    { preHandler: requirePerm(app, 'event:members:manage') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idUserParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid params' });
      }
      const body = updateMemberBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
      }
      try {
        const member = await updateMember(db, {
          eventId: params.data.id,
          userId: params.data.userId,
          role: body.data.role,
          splitPct: body.data.splitPct,
          actorUserId: user.id,
        });
        return reply.send(member);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- DELETE /v1/events/:id/members/:userId ----
  app.delete(
    '/v1/events/:id/members/:userId',
    { preHandler: requirePerm(app, 'event:members:manage') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idUserParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid params' });
      }
      try {
        await removeMember(db, {
          eventId: params.data.id,
          userId: params.data.userId,
          actorUserId: user.id,
        });
        return reply.code(204).send();
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );

  // ---- POST /v1/events/:id/ftp-credentials ----
  app.post(
    '/v1/events/:id/ftp-credentials',
    { preHandler: requirePerm(app, 'event:members:manage') },
    async (request, reply) => {
      const user = requireUser(request);
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const viewerOrgIds = await getViewerOrgIds(db, user.id);
      try {
        const cred = await rotateFtpCredential(db, {
          eventId: params.data.id,
          actorUserId: user.id,
          viewerOrgIds,
        });
        return reply.code(201).send(cred);
      } catch (err) {
        return handleServiceError(reply, err);
      }
    },
  );
};

export default eventsRoutes;
