// F4.10 — inbound print-lab webhook receiver.
//
// POST /v1/webhooks/print-lab/:lab_code — public (RBAC-exempt). Validates the
// per-lab HMAC signature over the raw body + timestamp (5-min replay window),
// then applies the state/tracking change (deduped on (lab_code, webhook_id)).
//
// The signature scheme reuses @pkg/integrations (sha256 over `${ts}.${body}`).
// The exact Bay Photo header names are mapped here; confirm against their spec
// during onboarding. The per-lab secret is resolved from env
// PRINT_LAB_<LABCODE>_WEBHOOK_SECRET (injectable for tests).

import type { DbClient } from '@pkg/db';
import { isPrintLabCode, verifyWebhookSignature } from '@pkg/integrations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { applyWebhookEvent } from '../services/print-fulfillment.js';

const MAX_BODY_BYTES = 64 * 1024;

const bodySchema = z.object({
  webhook_id: z.string().min(1).max(200),
  lab_order_id: z.string().min(1).max(200),
  status: z.string().min(1).max(64),
  tracking: z.object({ carrier: z.string(), number: z.string(), url: z.string().url() }).optional(),
});

interface RawJson {
  raw: string;
  json: unknown;
}

export type LabSecretResolver = (labCode: string) => string | null;

const defaultSecretResolver: LabSecretResolver = (labCode) =>
  process.env[`PRINT_LAB_${labCode.toUpperCase()}_WEBHOOK_SECRET`] ?? null;

export interface PrintWebhookOptions {
  db?: DbClient;
  secretResolver?: LabSecretResolver;
}

const printWebhookRoutes = async (
  app: FastifyInstance,
  opts: PrintWebhookOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const resolveSecret = opts.secretResolver ?? defaultSecretResolver;

  // Capture the raw body (needed for signature) AND the parsed JSON. This route
  // is an encapsulated plugin, so replacing the JSON parser here does not affect
  // global JSON parsing for other routes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
    (_req, body, done) => {
      try {
        done(null, { raw: body as string, json: JSON.parse(body as string) } satisfies RawJson);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post('/v1/webhooks/print-lab/:lab_code', async (request, reply) => {
    const labCode = (request.params as { lab_code: string }).lab_code;
    if (!isPrintLabCode(labCode)) return reply.code(404).send({ error: 'unknown_lab' });

    const secret = resolveSecret(labCode);
    if (!secret) return reply.code(503).send({ error: 'lab_webhooks_disabled' });

    const wrapped = request.body as RawJson | undefined;
    if (!wrapped?.raw) return reply.code(400).send({ error: 'invalid_body' });
    const parsed = bodySchema.safeParse(wrapped.json);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const tsRaw = request.headers['x-webhook-timestamp'];
    const sig = request.headers['x-webhook-signature'];
    const timestamp = typeof tsRaw === 'string' ? Number.parseInt(tsRaw, 10) : Number.NaN;
    if (typeof sig !== 'string' || !verifyWebhookSignature(secret, timestamp, wrapped.raw, sig)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const result = await applyWebhookEvent(
      db,
      {
        labCode,
        webhookId: parsed.data.webhook_id,
        labOrderId: parsed.data.lab_order_id,
        status: parsed.data.status,
        ...(parsed.data.tracking ? { tracking: parsed.data.tracking } : {}),
        signatureValid: true,
      },
      wrapped.json as Record<string, unknown>,
    );
    // Always 200 so the lab does not needlessly retry a duplicate/known event.
    return reply.code(200).send(result);
  });
};

export default printWebhookRoutes;
