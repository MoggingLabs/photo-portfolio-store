import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Point at individual schema files: drizzle-kit uses CJS require() and
  // chokes on the `.js` ESM extensions in src/schema/index.ts.
  schema: [
    './src/schema/users.ts',
    './src/schema/events.ts',
    './src/schema/photos.ts',
    './src/schema/search.ts',
    './src/schema/catalog.ts',
    './src/schema/commerce.ts',
    './src/schema/compliance.ts',
    './src/schema/cloud-imports.ts',
    './src/schema/integrations.ts',
    './src/schema/notifications.ts',
    './src/schema/participants.ts',
    './src/schema/print.ts',
    './src/schema/sftp.ts',
    './src/schema/timing.ts',
    './src/schema/webhooks.ts',
  ],
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  verbose: true,
  strict: true,
});
