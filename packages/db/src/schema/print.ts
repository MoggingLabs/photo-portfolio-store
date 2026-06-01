// Print fulfillment context — lab orders (F4.9) + inbound lab webhook log
// (F4.10). All tables in the Postgres `app` schema.
//
// print_lab_orders tracks one commerce order's print job at a lab. The
// idempotency key is the commerce order uuid; (lab_code, idempotency_key) is
// unique so a retried submit never creates a second lab order.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

export const printLabOrderState = app.enum('print_lab_order_state', [
  'pending',
  'submitted',
  'in_production',
  'shipped',
  'delivered',
  'cancelled',
  'failed',
]);

export const printLabOrders = app.table(
  'print_lab_orders',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs orders.id — cross-context, no FK.
    orderId: uuid('order_id').notNull(),
    labCode: text('lab_code').notNull(),
    // Lab-assigned order id (null until submitted).
    labOrderId: text('lab_order_id'),
    state: printLabOrderState('state').notNull().default('pending'),
    trackingCarrier: text('tracking_carrier'),
    trackingNumber: text('tracking_number'),
    trackingUrl: text('tracking_url'),
    // Client idempotency key (the commerce order uuid).
    idempotencyKey: text('idempotency_key').notNull(),
    // Retry bookkeeping for the fulfillment worker.
    attempts: integer('attempts').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, mode: 'date' }),
    needsManualIntervention: boolean('needs_manual_intervention').notNull().default(false),
    lastStatusAt: timestamp('last_status_at', { withTimezone: true, mode: 'date' }),
    rawStateJson: jsonb('raw_state_json'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // A retried submit must map to the same lab order.
    labIdemIdx: uniqueIndex('print_lab_orders_lab_idem_idx').on(
      table.labCode,
      table.idempotencyKey,
    ),
    orderIdx: index('print_lab_orders_order_idx').on(table.orderId),
    // Worker scan: orders awaiting submit / status poll.
    stateIdx: index('print_lab_orders_state_idx').on(table.state, table.nextRetryAt),
  }),
);

// F4.10 — inbound lab webhook events, deduped by (lab_code, webhook_id).
export const printLabWebhookEvents = app.table(
  'print_lab_webhook_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    labCode: text('lab_code').notNull(),
    webhookId: text('webhook_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    signatureValid: boolean('signature_valid').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    payloadJson: jsonb('payload_json'),
  },
  (table) => ({
    labWebhookIdx: uniqueIndex('print_lab_webhook_events_lab_webhook_idx').on(
      table.labCode,
      table.webhookId,
    ),
  }),
);

export const tables = {
  printLabOrders,
  printLabWebhookEvents,
};
