// Notifications context — participant "photos are ready" deliveries (F4.12) +
// bounce/complaint suppression. All tables in the Postgres `app` schema.
//
// A row is created (status='pending') by the selection/enqueue step and sent by
// the worker. Idempotency: one row per
// (participant, event, channel, dispatch_window_start) — the 30-minute digest
// window — so a restart never double-sends.

import { sql } from 'drizzle-orm';
import { index, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const app = pgSchema('app');

export const notificationChannel = app.enum('notification_channel', ['email', 'sms']);
export const notificationStatus = app.enum('notification_status', [
  'pending',
  'sent',
  'failed',
  'skipped',
  'suppressed',
]);

export const participantNotifications = app.table(
  'participant_notifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    participantId: uuid('participant_id').notNull(),
    eventId: uuid('event_id').notNull(),
    channel: notificationChannel('channel').notNull(),
    template: text('template').notNull(),
    status: notificationStatus('status').notNull().default('pending'),
    providerMessageId: text('provider_message_id'),
    dispatchWindowStart: timestamp('dispatch_window_start', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    payloadJson: jsonb('payload_json'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    windowIdx: uniqueIndex('participant_notifications_window_idx').on(
      table.participantId,
      table.eventId,
      table.channel,
      table.dispatchWindowStart,
    ),
    lookupIdx: index('participant_notifications_lookup_idx').on(
      table.participantId,
      table.eventId,
      table.channel,
    ),
    statusIdx: index('participant_notifications_status_idx').on(table.status, table.createdAt),
  }),
);

export const notificationSuppressions = app.table(
  'notification_suppressions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    channel: notificationChannel('channel').notNull(),
    // Lowercased email or E.164 phone.
    address: text('address').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    channelAddressIdx: uniqueIndex('notification_suppressions_channel_address_idx').on(
      table.channel,
      table.address,
    ),
  }),
);

export const tables = {
  participantNotifications,
  notificationSuppressions,
};
