// F4.1 — per-org connector configuration routes.
//
// Org-scoped (the repo models multi-org tenancy; the issue's generic
// "/api/integrations" maps to "/v1/orgs/:orgId/integrations" here). Gated by
// `integrations:manage` resolved against the org resource, so a platform admin
// (role perm) or that org's owner/admin (resource check) may manage connectors.
//
// GET    /v1/orgs/:orgId/integrations            — list connector status.
// PUT    /v1/orgs/:orgId/integrations/:type      — upsert credentials/config.
// DELETE /v1/orgs/:orgId/integrations/:type      — soft-delete (revoke creds).
// POST   /v1/orgs/:orgId/integrations/:type/test — connectivity check.
//
// Credentials are never returned by any response.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { getIntegrationsMasterKey } from '../lib/integrations-env.js';
import {
  type ConnectorTester,
  INTEGRATION_TYPES,
  IntegrationError,
  deleteIntegration,
  isIntegrationType,
  listIntegrations,
  testIntegration,
  upsertIntegration,
} from '../services/integrations.js';

const orgParamSchema = z.object({ orgId: z.string().uuid() });
const typeParamSchema = z.object({
  orgId: z.string().uuid(),
  type: z.enum(INTEGRATION_TYPES),
});
const upsertBodySchema = z
  .object({
    credentials: z.string().min(1).max(8192).optional(),
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const orgResource = (req: FastifyRequest) => {
  const parsed = orgParamSchema.safeParse(req.params);
  return parsed.success ? ({ kind: 'org', id: parsed.data.orgId } as const) : undefined;
};

export interface IntegrationsRoutesOptions {
  db?: DbClient;
  masterKey?: string;
  tester?: ConnectorTester;
}

const integrationsRoutes = async (
  app: FastifyInstance,
  opts: IntegrationsRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  // Resolve the master key lazily so boot/tests without it set don't crash.
  const masterKey = (): string => opts.masterKey ?? getIntegrationsMasterKey();
  const tester = opts.tester;

  app.get(
    '/v1/orgs/:orgId/integrations',
    { preHandler: app.requirePermission('integrations:manage', { resource: orgResource }) },
    async (request, reply) => {
      const params = orgParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      const items = await listIntegrations(db, params.data.orgId);
      return reply.code(200).send({ items });
    },
  );

  app.put(
    '/v1/orgs/:orgId/integrations/:type',
    { preHandler: app.requirePermission('integrations:manage', { resource: orgResource }) },
    async (request, reply) => {
      const params = typeParamSchema.safeParse(request.params);
      if (!params.success || !isIntegrationType(params.data.type)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body = upsertBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      const result = await upsertIntegration(db, params.data.orgId, params.data.type, body.data, {
        masterKey: masterKey(),
        ...(tester ? { tester } : {}),
      });
      return reply.code(200).send(result);
    },
  );

  app.delete(
    '/v1/orgs/:orgId/integrations/:type',
    { preHandler: app.requirePermission('integrations:manage', { resource: orgResource }) },
    async (request, reply) => {
      const params = typeParamSchema.safeParse(request.params);
      if (!params.success || !isIntegrationType(params.data.type)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      await deleteIntegration(db, params.data.orgId, params.data.type);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/orgs/:orgId/integrations/:type/test',
    { preHandler: app.requirePermission('integrations:manage', { resource: orgResource }) },
    async (request, reply) => {
      const params = typeParamSchema.safeParse(request.params);
      if (!params.success || !isIntegrationType(params.data.type)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      try {
        const result = await testIntegration(db, params.data.orgId, params.data.type, {
          masterKey: masterKey(),
          ...(tester ? { tester } : {}),
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof IntegrationError && err.code === 'not_found') {
          return reply.code(404).send({ error: 'not_found' });
        }
        request.log.error({ err }, 'integration test failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );
};

export default integrationsRoutes;
