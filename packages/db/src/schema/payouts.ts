// Finance / payout context — photographer ledger and payout lifecycle.
// All tables in the Postgres `app` schema. Cross-context FKs stay as plain
// uuid columns; application code enforces.
//
// Double-entry ledger overview:
//   Each sale produces two ledger_entries for the photographer's account:
//     CREDIT  kind='sale'         amountCents = gross sale proceeds
//     DEBIT   kind='platform_fee' amountCents = platform cut
//     DEBIT   kind='stripe_fee'   amountCents = Stripe processing fee
//   A payout produces:
//     DEBIT   kind='payout'       amountCents = net transferred to bank
//   Balance = SUM(credits) - SUM(debits). A non-negative balance is invariant
//   enforced by application code; the CHECK on amount_cents > 0 ensures no
//   zero-value noise entries enter the ledger.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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

// ---------- Enums ----------

export const ledgerDirection = app.enum('ledger_direction', ['debit', 'credit']);

export const ledgerKind = app.enum('ledger_kind', [
  'sale',
  'platform_fee',
  'stripe_fee',
  'refund',
  'payout',
  'adjustment',
]);

export const payoutStatus = app.enum('payout_status', ['pending', 'sent', 'paid', 'failed']);

// ---------- payout_accounts ----------
// One record per photographer. status lifecycle:
//   'pending'     — account row exists; Stripe Connect onboarding not started
//   'pending_kyc' — Stripe account created; KYC / requirements outstanding
//   'active'      — charges and payouts enabled; normal operating state
//   'restricted'  — Stripe flagged the account; charges may still work
//   'rejected'    — onboarding permanently blocked

export const payoutAccounts = app.table(
  'payout_accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs users.id — cross-context, no FK.
    photographerId: uuid('photographer_id').notNull().unique(),
    // Null until Stripe Connect account is created.
    stripeAccountId: text('stripe_account_id').unique(),
    // ISO 3166-1 alpha-2 country code, e.g. 'US', 'PT'.
    country: text('country').notNull(),
    // ISO 4217 currency code for payouts, e.g. 'USD', 'EUR'.
    currency: text('currency').notNull(),
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
    // Stripe requirements object serialized verbatim for dashboard display.
    requirements: jsonb('requirements').notNull().default(sql`'{}'::jsonb`),
    // See status lifecycle above.
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    statusIdx: index('payout_accounts_status_idx').on(table.status),
  }),
);

// ---------- payouts ----------
// One payout represents a single bank transfer to a photographer for a
// billing period. Ledger entries with kind='payout' reference this row.
// Declaration order: payouts before ledger_entries so ledger_entries can
// declare the same-file FK to payouts.id.

export const payouts = app.table(
  'payouts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    payoutAccountId: uuid('payout_account_id')
      .notNull()
      .references(() => payoutAccounts.id),
    // Inclusive billing period start (date only, no time component).
    periodStart: date('period_start').notNull(),
    // Inclusive billing period end.
    periodEnd: date('period_end').notNull(),
    // Sum of all sale credits in the period before deductions.
    grossCents: integer('gross_cents').notNull(),
    // Sum of platform_fee + stripe_fee debits in the period.
    feesCents: integer('fees_cents').notNull(),
    // gross - fees; amount wired to the photographer's bank.
    netCents: integer('net_cents').notNull(),
    currency: text('currency').notNull(),
    // Stripe Transfer or Payout object id; null until transfer is initiated.
    stripeTransferId: text('stripe_transfer_id'),
    status: payoutStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    accountPeriodIdx: index('payouts_account_period_idx').on(
      table.payoutAccountId,
      table.periodEnd,
    ),
  }),
);

// ---------- ledger_entries ----------
// Immutable double-entry ledger rows. Every financial event (sale, fee,
// refund, payout) produces one or more rows here. amount_cents is always
// positive; direction encodes the sign. The partial unique index on
// (order_id, kind, account_id, direction) prevents double-posting per order.

export const ledgerEntries = app.table(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => payoutAccounts.id),
    // refs orders.id — cross-context, no FK.
    orderId: uuid('order_id'),
    // refs refund_requests.id — cross-context, no FK.
    refundId: uuid('refund_id'),
    // Same-file FK; null for entries not yet associated with a payout run.
    payoutId: uuid('payout_id').references(() => payouts.id),
    direction: ledgerDirection('direction').notNull(),
    // Always positive; direction encodes the sign. Enforced by CHECK.
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    kind: ledgerKind('kind').notNull(),
    // Human-readable description for support and reconciliation dashboards.
    memo: text('memo').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    accountCreatedIdx: index('ledger_entries_account_created_idx').on(
      table.accountId,
      table.createdAt,
    ),
    orderIdx: index('ledger_entries_order_idx').on(table.orderId),
    // Prevents duplicate ledger entries per (order, kind, account, direction).
    dedupeIdx: uniqueIndex('ledger_entries_dedupe_idx')
      .on(table.orderId, table.kind, table.accountId, table.direction)
      .where(sql`${table.orderId} is not null`),
    amountPositive: check('ledger_entries_amount_positive', sql`${table.amountCents} > 0`),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  payoutAccounts,
  payouts,
  ledgerEntries,
};
