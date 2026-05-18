// Cron scheduler bootstrap. Owns the croner instances; the worker entrypoint
// calls startSchedulers() once at boot and keeps the returned handles so they
// can be stopped on shutdown.

import { Cron } from 'croner';
import pino from 'pino';

import { db } from '../lib/db.js';
import { qdrant } from '../lib/qdrant.js';
import { runRetentionPass } from './retention.js';

const log = pino({ name: 'retention-scheduler' });

/**
 * Wire up cron jobs and return the live handles. Caller is responsible for
 * calling .stop() on each handle during graceful shutdown.
 *
 * - Biometric retention: every 6 hours. Nightly is too lossy for the
 *   biometric SLA (a 24h window of over-retention is hard to defend under
 *   BIPA); every hour is wasteful given normal event lifecycles.
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

  return [retentionJob];
};
