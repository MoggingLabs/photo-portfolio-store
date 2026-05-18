import sensible from '@fastify/sensible';
import * as Sentry from '@sentry/node';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import rbacPlugin from './auth/rbac.js';
import swaggerPlugin from './plugins/swagger.js';
import adminAuditRoutes from './routes/admin/audit.js';
import authRoutes from './routes/auth.js';
import eventsRoutes from './routes/events.js';
import uploadsRoutes from './routes/uploads.js';

export const buildServer = async (): Promise<FastifyInstance> => {
  const logLevel = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV === 'development';

  const opts: FastifyServerOptions = isDev
    ? {
        logger: {
          level: logLevel,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        },
        disableRequestLogging: false,
      }
    : {
        logger: { level: logLevel },
        disableRequestLogging: false,
      };

  const app = Fastify(opts);

  await app.register(sensible);

  if (process.env.SENTRY_DSN) {
    Sentry.setupFastifyErrorHandler(app);
  }

  // RBAC must register before any protected routes so app.requirePermission is decorated.
  await app.register(rbacPlugin);

  // Swagger UI (dev or when explicitly enabled).
  if (isDev || process.env.SWAGGER_UI_ENABLED === 'true') {
    await app.register(swaggerPlugin);
  }

  // Routes
  await app.register(authRoutes);
  await app.register(eventsRoutes);
  await app.register(uploadsRoutes);
  await app.register(adminAuditRoutes);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/', async () => ({ name: 'photo-portfolio-store api', ok: true }));

  return app;
};
