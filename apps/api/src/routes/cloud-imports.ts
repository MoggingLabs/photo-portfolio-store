// F4.4 — Google Drive / Dropbox import routes.
//
// POST /v1/orgs/:orgId/integrations/:provider/connect  (integrations:manage) -> { authorizeUrl }
// GET  /v1/integrations/:provider/callback             (PUBLIC) -> 302 after token exchange
// POST /v1/events/:id/imports                          (event:write) -> create import
// GET  /v1/events/:id/imports/:importId                (event:write) -> progress
//
// The callback has no bearer auth (it's a browser redirect from the provider);
// it is exempted in auth/rbac.ts and gated by the signed `state` instead.

import type { DbClient } from '@pkg/db';
import type { CloudHttpClient, CloudProvider } from '@pkg/integrations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type CloudOAuthConfig, getCloudOAuthConfig } from '../lib/cloud-import-env.js';
import { db as defaultDb } from '../lib/db.js';
import {
  CloudImportError,
  createCloudImport,
  getCloudImportProgress,
} from '../services/cloud-imports.js';
import { buildConnectUrl, completeConnection } from '../services/cloud-oauth.js';

const providerSchema = z.enum(['gdrive', 'dropbox']);
const orgConnectParams = z.object({ orgId: z.string().uuid(), provider: providerSchema });
const callbackParams = z.object({ provider: providerSchema });
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});
const eventImportParams = z.object({ id: z.string().uuid(), importId: z.string().uuid() });
const bindBody = z
  .object({ provider: providerSchema, remoteFolderId: z.string().min(1).max(1024) })
  .strict();
const idOnly = z.object({ id: z.string().uuid() });

const orgResource = (req: FastifyRequest) => {
  const parsed = orgConnectParams.safeParse(req.params);
  return { kind: 'org', id: parsed.success ? parsed.data.orgId : '__invalid__' } as const;
};
const eventResource = (req: FastifyRequest): { kind: 'event'; id: string } | undefined => {
  const parsed = idOnly.safeParse(req.params);
  return parsed.success ? { kind: 'event', id: parsed.data.id } : undefined;
};

// Default token-exchange HTTP client (Node fetch; form-encodes token requests).
// Tests inject a stub so the live token endpoint is never hit.
const defaultHttpClient: CloudHttpClient = async (method, url, headers, body) => {
  const isForm = headers['content-type']?.includes('x-www-form-urlencoded');
  const encodedBody =
    body === undefined
      ? undefined
      : isForm
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body);
  const res = await fetch(url, {
    method,
    headers,
    ...(encodedBody !== undefined ? { body: encodedBody } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body; keep raw text */
  }
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    respHeaders[k.toLowerCase()] = v;
  });
  return { status: res.status, body: parsed, headers: respHeaders };
};

export interface CloudImportRoutesOptions {
  db?: DbClient;
  oauthConfig?: (provider: CloudProvider) => CloudOAuthConfig | null;
  httpClient?: CloudHttpClient;
  now?: () => Date;
}

const cloudImportRoutes = async (
  app: FastifyInstance,
  opts: CloudImportRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const resolveConfig = opts.oauthConfig ?? getCloudOAuthConfig;
  const http = opts.httpClient ?? defaultHttpClient;
  const now = opts.now;

  app.post(
    '/v1/orgs/:orgId/integrations/:provider/connect',
    { preHandler: app.requirePermission('integrations:manage', { resource: orgResource }) },
    async (request, reply) => {
      const params = orgConnectParams.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const cfg = resolveConfig(params.data.provider);
      if (!cfg) return reply.code(503).send({ error: 'not_configured' });
      const userId = request.user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const authorizeUrl = buildConnectUrl(
        params.data.orgId,
        userId,
        params.data.provider,
        cfg,
        now,
      );
      return reply.code(200).send({ authorizeUrl });
    },
  );

  // PUBLIC: no preHandler (exempted in rbac.ts). Always redirects to the app.
  app.get('/v1/integrations/:provider/callback', async (request, reply) => {
    const params = callbackParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const provider = params.data.provider;
    const cfg = resolveConfig(provider);
    if (!cfg) return reply.code(503).send({ error: 'not_configured' });
    const appBase = cfg.appBaseUrl.replace(/\/$/, '');
    const fail = () =>
      reply
        .code(302)
        .redirect(`${appBase}/integrations/callback?status=error&provider=${provider}`);
    const query = callbackQuery.safeParse(request.query);
    if (!query.success || query.data.error || !query.data.code || !query.data.state) return fail();
    try {
      await completeConnection(db, provider, query.data.code, query.data.state, cfg, http, now);
      return reply
        .code(302)
        .redirect(`${appBase}/integrations/callback?status=connected&provider=${provider}`);
    } catch (err) {
      request.log.warn({ err }, 'cloud oauth callback failed');
      return fail();
    }
  });

  app.post(
    '/v1/events/:id/imports',
    { preHandler: app.requirePermission('event:write', { resource: eventResource }) },
    async (request, reply) => {
      const params = idOnly.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = bindBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      const userId = request.user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      try {
        const result = await createCloudImport(db, {
          eventId: params.data.id,
          userId,
          provider: body.data.provider,
          remoteFolderId: body.data.remoteFolderId,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof CloudImportError && err.code === 'not_connected') {
          return reply.code(409).send({ error: 'not_connected' });
        }
        if (err instanceof CloudImportError && err.code === 'event_not_found') {
          return reply.code(404).send({ error: 'not_found' });
        }
        request.log.error({ err }, 'cloud import create failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  app.get(
    '/v1/events/:id/imports/:importId',
    { preHandler: app.requirePermission('event:write', { resource: eventResource }) },
    async (request, reply) => {
      const params = eventImportParams.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const progress = await getCloudImportProgress(db, params.data.id, params.data.importId, now);
      if (!progress) return reply.code(404).send({ error: 'not_found' });
      return reply.code(200).send(progress);
    },
  );
};

export default cloudImportRoutes;
