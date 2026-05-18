// Fastify plugin that loads the repo-level openapi.yaml and mounts Swagger UI
// at /docs. Gated behind NODE_ENV !== 'production' OR explicit
// SWAGGER_UI_ENABLED=true so production deployments don't ship the UI unless
// explicitly opted in. The spec itself is registered regardless so other code
// (e.g. validation, /openapi.json) can read it.

import { readFileSync } from 'node:fs';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { parse as parseYaml } from 'yaml';
import { openApiPath } from '../lib/openapi-path.js';

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  [key: string]: unknown;
}

const isUiEnabled = (): boolean => {
  if (process.env.SWAGGER_UI_ENABLED === 'true') return true;
  return process.env.NODE_ENV !== 'production';
};

export default fp(async (app) => {
  const raw = readFileSync(openApiPath, 'utf8');
  const spec = parseYaml(raw) as OpenApiDocument;

  // @fastify/swagger types `specification.document` as a Partial<OpenAPI> shape
  // that is overly strict for our case. Cast to bypass; runtime accepts any
  // valid OpenAPI 3.x doc.
  await app.register(swagger, {
    mode: 'static',
    specification: { document: spec as unknown as Record<string, unknown> },
  } as never);

  if (isUiEnabled()) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  }
});
