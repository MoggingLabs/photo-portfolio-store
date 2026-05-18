// Resumable multipart upload routes (F1.11).
//
// The API never proxies chunk bytes — clients PUT chunks directly to R2 using
// the presigned URL returned by POST /v1/uploads/:sessionId/chunk/:partNumber.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db } from '../lib/db.js';
import {
  UploadValidationError,
  abortUpload,
  completeUpload,
  completeUploadInputSchema,
  initUpload,
  initUploadInputSchema,
  presignChunk,
} from '../services/uploads.js';

// ---------- Param schemas ----------

const uuidSchema = z.string().uuid();

const eventParamSchema = z.object({ eventId: uuidSchema });
const sessionParamSchema = z.object({ sessionId: uuidSchema });
const chunkParamSchema = z.object({
  sessionId: uuidSchema,
  partNumber: z.coerce.number().int().min(1).max(10_000),
});

// ---------- Auth helpers ----------

// FastifyRequest.user is canonically declared in src/auth/rbac.ts.
const requireUserId = (request: FastifyRequest): string => {
  const userId = request.user?.id;
  if (!userId) {
    const err = new UploadValidationError(401, 'Authentication required');
    throw err;
  }
  return userId;
};

// ---------- Error mapper ----------

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof UploadValidationError) {
    return reply.code(error.statusCode).send({
      success: false,
      error: error.message,
    });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      success: false,
      error: 'Invalid request body',
      details: error.issues,
    });
  }
  throw error;
};

// ---------- Plugin ----------

type RequirePermission = (permission: string) => (req: FastifyRequest) => Promise<void> | void;

const getRequirePermission = (app: FastifyInstance): RequirePermission | null => {
  const candidate = (app as unknown as { requirePermission?: RequirePermission }).requirePermission;
  return typeof candidate === 'function' ? candidate : null;
};

export default async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  const requirePermission = getRequirePermission(app);
  const mediaUploadGuard = requirePermission ? requirePermission('media:upload') : undefined;

  // POST /v1/events/:eventId/uploads/init
  app.post(
    '/v1/events/:eventId/uploads/init',
    { ...(mediaUploadGuard ? { preHandler: mediaUploadGuard } : {}) },
    async (request, reply) => {
      try {
        const { eventId } = eventParamSchema.parse(request.params);
        const body = initUploadInputSchema.parse(request.body);
        const photographerUserId = requireUserId(request);

        const result = await initUpload(db, eventId, photographerUserId, body);
        return reply.code(201).send({ success: true, data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  // POST /v1/uploads/:sessionId/chunk/:partNumber
  app.post(
    '/v1/uploads/:sessionId/chunk/:partNumber',
    { ...(mediaUploadGuard ? { preHandler: mediaUploadGuard } : {}) },
    async (request, reply) => {
      try {
        const { sessionId, partNumber } = chunkParamSchema.parse(request.params);
        requireUserId(request);

        const result = await presignChunk(db, sessionId, partNumber);
        return reply.code(200).send({ success: true, data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  // POST /v1/uploads/:sessionId/complete
  app.post(
    '/v1/uploads/:sessionId/complete',
    { ...(mediaUploadGuard ? { preHandler: mediaUploadGuard } : {}) },
    async (request, reply) => {
      try {
        const { sessionId } = sessionParamSchema.parse(request.params);
        const body = completeUploadInputSchema.parse(request.body);
        requireUserId(request);

        const result = await completeUpload(db, sessionId, body);
        return reply.code(201).send({ success: true, data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  // DELETE /v1/uploads/:sessionId
  app.delete(
    '/v1/uploads/:sessionId',
    { ...(mediaUploadGuard ? { preHandler: mediaUploadGuard } : {}) },
    async (request, reply) => {
      try {
        const { sessionId } = sessionParamSchema.parse(request.params);
        requireUserId(request);

        await abortUpload(db, sessionId);
        return reply.code(204).send();
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
}
