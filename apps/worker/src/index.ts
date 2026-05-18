import './instrument.js';
import { coreEnvSchema, parseEnv } from '@pkg/env';
import * as Sentry from '@sentry/node';
import pino, { type LoggerOptions } from 'pino';

import { startSchedulers } from './jobs/index.js';
import { startWorkers, stopWorkers } from './workers/index.js';

const env = parseEnv(coreEnvSchema);

const baseOptions: LoggerOptions = { level: env.LOG_LEVEL };
const loggerOptions: LoggerOptions =
  env.NODE_ENV === 'development'
    ? {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : baseOptions;

const logger = pino(loggerOptions);

const workers = startWorkers();
const crons = startSchedulers();

logger.info(
  { env: env.NODE_ENV, workers: Object.keys(workers), cronCount: crons.length },
  'worker booted; processing queues',
);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  for (const cron of crons) cron.stop();
  await stopWorkers(workers);
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('uncaughtException', (error) => {
  Sentry.captureException(error);
  throw error;
});

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
  throw reason;
});

await new Promise<void>(() => {});
