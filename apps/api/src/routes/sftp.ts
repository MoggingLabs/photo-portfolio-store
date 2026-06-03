// F4.2 — per-event SFTP provisioning routes (event-scoped, event:write).
//
// POST   /v1/events/:id/sftp/provision  — create account, return private key once.
// POST   /v1/events/:id/sftp/rotate     — rotate key, return new private key once.
// DELETE /v1/events/:id/sftp            — disable the account.
// GET    /v1/events/:id/sftp            — account status (no key material).

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import {
  SftpError,
  disableSftp,
  getSftpAccount,
  provisionSftp,
  rotateSftp,
} from '../services/sftp.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const eventResource = (req: FastifyRequest): { kind: 'event'; id: string } | undefined => {
  const parsed = idParamSchema.safeParse(req.params);
  return parsed.success ? { kind: 'event', id: parsed.data.id } : undefined;
};

export interface SftpRoutesOptions {
  db?: DbClient;
}

const sftpRoutes = async (app: FastifyInstance, opts: SftpRoutesOptions = {}): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const perm = () => app.requirePermission('event:write', { resource: eventResource });

  app.post('/v1/events/:id/sftp/provision', { preHandler: perm() }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    try {
      const result = await provisionSftp(db, params.data.id);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof SftpError && err.code === 'already_provisioned') {
        return reply.code(409).send({ error: 'already_provisioned' });
      }
      request.log.error({ err }, 'sftp provision failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  app.post('/v1/events/:id/sftp/rotate', { preHandler: perm() }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    try {
      const result = await rotateSftp(db, params.data.id);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof SftpError && err.code === 'not_found') {
        return reply.code(404).send({ error: 'not_found' });
      }
      request.log.error({ err }, 'sftp rotate failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  app.delete('/v1/events/:id/sftp', { preHandler: perm() }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    await disableSftp(db, params.data.id);
    return reply.code(204).send();
  });

  app.get('/v1/events/:id/sftp', { preHandler: perm() }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const account = await getSftpAccount(db, params.data.id);
    if (!account) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(account);
  });
};

export default sftpRoutes;
