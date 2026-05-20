// F2.11 — double-entry ledger writer + internal account model.
//
// SIGN CONVENTION (account balance = SUM(credits) - SUM(debits)):
//   - photographer account: CREDIT on sale (we owe them), DEBIT on payout and
//     on refund clawback. A positive balance is what we still owe.
//   - platform_revenue:      CREDIT = platform fee earned.
//   - stripe_fee:            CREDIT = processing fee accounted.
//   - platform_cash:         DEBIT on sale, CREDIT on refund. An internal
//     clearing account; its sign is not meant to be read as a bank balance.
//
// A SALE batch for gross G, stripe fee S, platform fee P and photographer nets
// N_i (sum N_i = G - S - P) is:
//   DEBIT  platform_cash      G            kind='sale'
//   CREDIT stripe_fee         S            kind='stripe_fee'
//   CREDIT platform_revenue   P            kind='platform_fee'
//   CREDIT photographer_i     N_i          kind='sale'   (one per photographer)
//   => credits (S + P + sum N_i) == debits (G). Balanced.
//
// A REFUND batch mirrors the proportional share with directions flipped.
//
// Idempotency: order-scoped entries are deduped by the partial unique index
// (order_id, kind, account_id, direction). The split engine MUST emit at most
// one entry per (account, kind, direction) per order, so all of a
// photographer's line revenue in an order is aggregated into a single entry.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';

const { ledgerAccounts, ledgerEntries } = schema.payouts.tables;

// ---------- Types ----------

export type LedgerDirection = 'debit' | 'credit';
export type LedgerKind =
  | 'sale'
  | 'platform_fee'
  | 'stripe_fee'
  | 'refund'
  | 'payout'
  | 'adjustment';
export type PlatformAccountKind = 'platform_cash' | 'platform_revenue' | 'stripe_fee';

export interface LedgerEntryInput {
  accountId: string;
  direction: LedgerDirection;
  amountCents: number;
  currency: string;
  kind: LedgerKind;
  memo: string;
  orderId?: string | null;
  refundId?: string | null;
  payoutId?: string | null;
}

// ---------- Fee configuration ----------

// Platform fee in basis points (10%). Overridable per-event in a later
// milestone; callers should read this rather than hard-coding.
export const DEFAULT_PLATFORM_FEE_BPS = 1000;

// Stripe standard processing fee estimate: 2.9% + 30c. Used when the actual
// balance-transaction fee is not available at sale time. The exact fee can be
// reconciled later with an 'adjustment' entry.
export const STRIPE_PCT_BPS = 290;
export const STRIPE_FLAT_CENTS = 30;

export const estimatePlatformFeeCents = (
  grossCents: number,
  bps: number = DEFAULT_PLATFORM_FEE_BPS,
): number => Math.round((grossCents * bps) / 10000);

export const estimateStripeFeeCents = (grossCents: number): number =>
  Math.round((grossCents * STRIPE_PCT_BPS) / 10000) + STRIPE_FLAT_CENTS;

// ---------- Errors ----------

export class LedgerError extends Error {
  constructor(
    public readonly code: 'unbalanced' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

// ---------- Cents-exact allocation ----------

// Split totalCents across weights so the parts sum EXACTLY to totalCents
// (largest-remainder method). Deterministic: leftover cents go to the largest
// fractional remainders, ties broken by lowest index. All-zero weights => even
// split by index order. Supports negative totals (e.g. reversals).
export const allocateProportional = (
  totalCents: number,
  weights: ReadonlyArray<number>,
): number[] => {
  const n = weights.length;
  if (n === 0) return [];
  if (!Number.isInteger(totalCents)) {
    throw new LedgerError('invalid', `totalCents must be an integer (got ${totalCents})`);
  }
  const weightSum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  // Even split when there is no positive weight to distribute by.
  const effective = weightSum > 0 ? weights.map((w) => Math.max(0, w)) : weights.map(() => 1);
  const effSum = weightSum > 0 ? weightSum : n;

  const exact = effective.map((w) => (totalCents * w) / effSum);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = totalCents - floors.reduce((s, v) => s + v, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.i - b.i));

  const result = [...floors];
  const step = remainder >= 0 ? 1 : -1;
  let idx = 0;
  while (remainder !== 0) {
    const target = order[idx % n];
    if (target) result[target.i] = (result[target.i] ?? 0) + step;
    remainder -= step;
    idx += 1;
  }
  return result;
};

// ---------- Balance check ----------

// Throws unless SUM(debits) === SUM(credits) within every currency present.
export const assertBalanced = (entries: ReadonlyArray<LedgerEntryInput>): void => {
  const netByCurrency = new Map<string, number>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0) {
      throw new LedgerError(
        'invalid',
        `amountCents must be a positive integer (got ${entry.amountCents})`,
      );
    }
    const signed = entry.direction === 'debit' ? entry.amountCents : -entry.amountCents;
    netByCurrency.set(entry.currency, (netByCurrency.get(entry.currency) ?? 0) + signed);
  }
  for (const [currency, net] of netByCurrency) {
    if (net !== 0) {
      throw new LedgerError(
        'unbalanced',
        `ledger batch does not balance for ${currency}: net ${net}`,
      );
    }
  }
};

// ---------- Writer ----------

// Validate and post a balanced batch atomically. Order-scoped entries are
// idempotent via the partial unique dedupe index; a replayed batch is a no-op.
export const postLedgerBatch = async (
  db: DbClient,
  entries: ReadonlyArray<LedgerEntryInput>,
): Promise<void> => {
  if (entries.length === 0) return;
  assertBalanced(entries);

  const rows = entries.map((entry) => ({
    accountId: entry.accountId,
    direction: entry.direction,
    amountCents: entry.amountCents,
    currency: entry.currency,
    kind: entry.kind,
    memo: entry.memo,
    orderId: entry.orderId ?? null,
    refundId: entry.refundId ?? null,
    payoutId: entry.payoutId ?? null,
  }));

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.insert(ledgerEntries).values(row).onConflictDoNothing();
    }
  });
};

// ---------- Account resolution ----------

// Returns the singleton platform account id, creating it on first use.
export const getPlatformAccountId = async (
  db: DbClient,
  kind: PlatformAccountKind,
): Promise<string> => {
  const found = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, kind))
    .limit(1);
  const [existing] = found;
  if (existing) return existing.id;

  const inserted = await db
    .insert(ledgerAccounts)
    .values({ kind })
    .onConflictDoNothing()
    .returning({ id: ledgerAccounts.id });
  const [created] = inserted;
  if (created) return created.id;

  // Lost a create race; re-read.
  const retry = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.kind, kind))
    .limit(1);
  const [row] = retry;
  if (!row) throw new LedgerError('invalid', `failed to resolve platform account ${kind}`);
  return row.id;
};

// Finds or creates the photographer's ledger account (independent of Stripe).
export const ensurePhotographerAccount = async (
  db: DbClient,
  photographerId: string,
): Promise<string> => {
  const found = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, 'photographer'),
        eq(ledgerAccounts.photographerId, photographerId),
      ),
    )
    .limit(1);
  const [existing] = found;
  if (existing) return existing.id;

  const inserted = await db
    .insert(ledgerAccounts)
    .values({ kind: 'photographer', photographerId })
    .onConflictDoNothing()
    .returning({ id: ledgerAccounts.id });
  const [created] = inserted;
  if (created) return created.id;

  const retry = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, 'photographer'),
        eq(ledgerAccounts.photographerId, photographerId),
      ),
    )
    .limit(1);
  const [row] = retry;
  if (!row) {
    throw new LedgerError('invalid', `failed to resolve photographer account ${photographerId}`);
  }
  return row.id;
};

// Idempotent boot seed for the platform singleton accounts.
export const seedPlatformLedgerAccounts = async (db: DbClient): Promise<void> => {
  const kinds: ReadonlyArray<PlatformAccountKind> = [
    'platform_cash',
    'platform_revenue',
    'stripe_fee',
  ];
  for (const kind of kinds) {
    await getPlatformAccountId(db, kind);
  }
};

// Net balance of an account = SUM(credits) - SUM(debits). For photographer
// accounts this is the amount currently owed.
export const accountBalanceCents = async (db: DbClient, accountId: string): Promise<number> => {
  const rows = await db
    .select({ direction: ledgerEntries.direction, amountCents: ledgerEntries.amountCents })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  let balance = 0;
  for (const row of rows) {
    balance += row.direction === 'credit' ? row.amountCents : -row.amountCents;
  }
  return balance;
};
