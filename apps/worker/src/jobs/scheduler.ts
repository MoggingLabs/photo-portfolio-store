// Cron scheduler bootstrap. Owns the croner instances; the worker entrypoint
// calls startSchedulers() once at boot and keeps the returned handles so they
// can be stopped on shutdown.

import { Cron } from 'croner';
import pino from 'pino';
import { request } from 'undici';

import { db } from '../lib/db.js';
import { workerEnv } from '../lib/env.js';
import { qdrant } from '../lib/qdrant.js';
import { runBipaRetentionDestruction } from './bipa-retention.js';
import { triggerPayoutRun } from './payouts.js';
import { runRetentionPass } from './retention.js';
import { runTakedownSlaCheck } from './takedown-sla.js';
import { type WebhookHttpClient, runWebhookDeliveries } from './webhook-delivery.js';

const log = pino({ name: 'retention-scheduler' });
const payoutLog = pino({ name: 'payout-scheduler' });
const slaLog = pino({ name: 'takedown-sla' });
const bipaLog = pino({ name: 'bipa-retention' });
const webhookLog = pino({ name: 'webhook-delivery' });

const WEBHOOK_TIMEOUT_MS = 10_000;

const webhookHttpClient: WebhookHttpClient = async (url, body, headers) => {
  const res = await request(url, {
    method: 'POST',
    body,
    headers,
    headersTimeout: WEBHOOK_TIMEOUT_MS,
    bodyTimeout: WEBHOOK_TIMEOUT_MS,
  });
  const text = await res.body.text();
  return { status: res.statusCode, body: text };
};

/**
 * Wire up cron jobs and return the live handles. Caller is responsible for
 * calling .stop() on each handle during graceful shutdown.
 *
 * - Biometric retention: every 6 hours. Nightly is too lossy for the
 *   biometric SLA (a 24h window of over-retention is hard to defend under
 *   BIPA); every hour is wasteful given normal event lifecycles.
 * - Payout run: weekly, Mondays at 03:00 UTC. Cadence is fixed regardless of
 *   public holidays (locked product decision). Minimum payout = 0 (also
 *   locked). The job calls the internal API endpoint rather than importing
 *   payout logic directly so the worker stays free of API-layer deps.
 * - `protect: true` skips overlapping ticks if a previous run is still in
 *   progress — important for slow purges that span many events.
 */
export const startSchedulers = (): Cron[] => {
  const retentionJob = new Cron(
    '0 */6 * * *',
    { name: 'biometric-retention', protect: true },
    async () => {
      try {
        const result = await runRetentionPass(db, qdrant);
        log.info({ result }, 'retention pass complete');
      } catch (err) {
        log.error({ err }, 'retention pass failed');
      }
    },
  );

  // Weekly payout cron — Mondays 03:00 UTC.
  // Fixed day regardless of holidays (locked decision); no minimum (locked decision).
  const payoutJob = new Cron('0 3 * * 1', { name: 'payout-run', protect: true }, async () => {
    try {
      const result = await triggerPayoutRun();
      if (result.ok) {
        payoutLog.info({ status: result.status }, 'payout-run triggered');
      } else {
        payoutLog.error({ status: result.status }, 'payout-run trigger failed');
      }
    } catch (err) {
      payoutLog.error({ err }, 'payout-run cron error');
    }
  });

  // Takedown SLA alert: hourly sweep. Each overdue row emits a structured
  // warn log that the on-call alerting layer matches on
  // (action='takedown.sla_breach'). 24h SLA is enforced by the DB trigger.
  const slaJob = new Cron('0 * * * *', { name: 'takedown-sla-check', protect: true }, async () => {
    try {
      const result = await runTakedownSlaCheck(db, slaLog);
      slaLog.info({ overdueCount: result.overdueCount }, 'takedown sla sweep complete');
    } catch (err) {
      slaLog.error({ err }, 'takedown sla sweep failed');
    }
  });

  // BIPA retention destruction: daily at 04:00 UTC. Drops face_vectors +
  // Qdrant collections (when no other active subject still references the
  // event) and revokes consents whose statutory retention window has expired.
  const bipaJob = new Cron('0 4 * * *', { name: 'bipa-retention', protect: true }, async () => {
    try {
      const result = await runBipaRetentionDestruction(db, qdrant);
      bipaLog.info({ result }, 'bipa retention destruction complete');
    } catch (err) {
      bipaLog.error({ err }, 'bipa retention destruction failed');
    }
  });

  // Outbound webhook delivery: every minute. Picks up due deliveries and
  // performs the signed HTTP POST with retry/backoff + circuit breaking.
  // Skipped entirely until the master key is provisioned.
  const webhookJob = new Cron(
    '* * * * *',
    { name: 'webhook-delivery', protect: true },
    async () => {
      if (!workerEnv.INTEGRATIONS_MASTER_KEY) return;
      try {
        const result = await runWebhookDeliveries(db, {
          masterKey: workerEnv.INTEGRATIONS_MASTER_KEY,
          httpClient: webhookHttpClient,
        });
        if (result.processed > 0) webhookLog.info({ result }, 'webhook delivery sweep complete');
      } catch (err) {
        webhookLog.error({ err }, 'webhook delivery sweep failed');
      }
    },
  );

  return [retentionJob, payoutJob, slaJob, bipaJob, webhookJob];
};
