// Structured logger shared by worker handlers. Pino in JSON mode by default;
// pretty mode in development.

import pino, { type Logger, type LoggerOptions } from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isDev = (process.env.NODE_ENV ?? 'development') === 'development';

const options: LoggerOptions = isDev
  ? {
      level,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    }
  : { level };

export const logger: Logger = pino(options);
