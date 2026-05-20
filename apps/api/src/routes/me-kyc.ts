// F2.9 — Self-service KYC / Stripe Connect Express onboarding routes.
//
// These are "me" routes: owner = request.user. There is no RBAC permission
// gate — the main thread adds /v1/me/kyc/* to the RBAC exempt list.
//
// POST /v1/me/kyc/start
//   Authenticated photographer starts or resumes Connect onboarding.
//   Returns a hosted onboarding URL that expires in ~5 minutes.
//
// GET /v1/me/kyc/status
//   Authenticated photographer checks onboarding / KYC state.
//   Returns live data from Stripe plus a continue or dashboard link.

import type { DbClient } from '@pkg/db';
import { parseEnv, z } from '@pkg/env';
import type { FastifyInstance } from 'fastify';

import { db as defaultDb } from '../lib/db.js';
import {
  ConnectServiceError,
  type StripeConnectClient,
  getKycStatus,
  startOnboarding,
} from '../services/connect.js';

// ---------- Env ----------

const envSchema = z.object({
  APP_BASE_URL: z.string().min(1),
});

// ---------- Body schema ----------

const startBodySchema = z.object({
  country: z.string().length(2).optional(),
  currency: z.string().length(3).optional(),
});

// ---------- Error mapping ----------

const mapConnectError = (
  reply: import('fastify').FastifyReply,
  err: ConnectServiceError,
): import('fastify').FastifyReply => {
  switch (err.code) {
    case 'already_onboarded':
      return reply.code(409).send({ error: 'ALREADY_ONBOARDED', message: err.message });
    case 'account_not_found':
      return reply.code(404).send({ error: 'not_found', message: err.message });
    case 'invalid_request':
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    case 'stripe_error':
      return reply.code(502).send({ error: 'stripe_error', message: err.message });
    default:
      return reply.code(500).send({ error: 'server_error' });
  }
};

// ---------- Plugin options ----------

export interface MeKycRoutesOptions {
  db?: DbClient;
  /** Injected in tests to avoid a real Stripe singleton. */
  stripe?: StripeConnectClient;
}

// ---------- Plugin ----------

const meKycRoutes = async (app: FastifyInstance, opts: MeKycRoutesOptions = {}): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---------- POST /v1/me/kyc/start ----------

  app.post('/v1/me/kyc/start', async (request, reply) => {
    if (!request.user?.id) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const body = startBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: body.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const env = parseEnv(envSchema);
    const baseUrl = env.APP_BASE_URL.replace(/\/$/, '');

    // Defaults: 'US' / 'usd'. Overridden by caller when a non-US photographer
    // registers. A future milestone may derive this from the event's country.
    const country = body.data.country ?? 'US';
    const currency = body.data.currency ?? 'usd';

    const refreshUrl = `${baseUrl}/dashboard/kyc?refresh=1`;
    const returnUrl = `${baseUrl}/dashboard/kyc?return=1`;

    try {
      const result = await startOnboarding(
        db,
        request.user.id,
        { country, currency, refreshUrl, returnUrl },
        opts.stripe,
      );
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof ConnectServiceError) return mapConnectError(reply, err);
      request.log.error({ err }, 'kyc start failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  // ---------- GET /v1/me/kyc/status ----------

  app.get('/v1/me/kyc/status', async (request, reply) => {
    if (!request.user?.id) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const env = parseEnv(envSchema);
    const baseUrl = env.APP_BASE_URL.replace(/\/$/, '');

    const refreshUrl = `${baseUrl}/dashboard/kyc?refresh=1`;
    const returnUrl = `${baseUrl}/dashboard/kyc?return=1`;

    try {
      const result = await getKycStatus(
        db,
        request.user.id,
        { refreshUrl, returnUrl },
        opts.stripe,
      );
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof ConnectServiceError) return mapConnectError(reply, err);
      request.log.error({ err }, 'kyc status failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default meKycRoutes;
