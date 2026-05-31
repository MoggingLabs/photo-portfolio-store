// Webhooks context — outbound webhook subscriptions + delivery log (F4.11).
// All tables in the Postgres `app` schema.
//
// Subscriptions are per-org. The HMAC secret is stored envelope-encrypted
// (@pkg/integrations crypto); it is generated server-side and shown to the
// caller exactly once at creation. Deliveries are an append-only attempt log
// used for retries, the deliveries UI, and circuit-breaking.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

export const webhookDeliveryStatus = app.enum('webhook_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'retrying',
]);

export const webhookSubscriptions = app.table(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs organizations.id — cross-context, no FK.
    orgId: uuid('org_id').notNull(),
    targetUrl: text('target_url').notNull(),
    // Envelope-encrypted HMAC secret (never returned after creation).
    secretEncrypted: text('secret_encrypted').notNull(),
    eventTypes: text('event_types').array().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    disabledReason: text('disabled_reason'),
    // Circuit breaker: consecutive failures + cooldown window.
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    orgIdx: index('webhook_subscriptions_org_idx').on(table.orgId),
  }),
);

export const webhookDeliveries = app.table(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    subscriptionId: uuid('subscription_id').notNull(),
    // The webhook event id (UUIDv7) sent in X-Webhook-Id; receivers may dedupe.
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    httpStatus: integer('http_status'),
    responseBodyExcerpt: text('response_body_excerpt'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),
    payloadJson: jsonb('payload_json'),
  },
  (table) => ({
    subIdx: index('webhook_deliveries_sub_idx').on(table.subscriptionId, table.scheduledAt),
  }),
);

export const tables = {
  webhookSubscriptions,
  webhookDeliveries,
};
