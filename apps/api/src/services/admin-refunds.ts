// F2.7 — Admin refund decision service.
//
// IDEMPOTENCY KEY POLICY:
//   key = `refund:${refundRequestId}:${attempt}` where attempt is incremented
//   once per decideRefund invocation BEFORE the Stripe call. This means:
//   - Within a single call the key is stable (Stripe deduplicates concurrent
//     duplicates with the same key).
//   - If the admin retries after a stripe_error the NEXT call uses attempt+1,
//     producing a new key. The prior failed attempt's refundAttempts value is
//     persisted, so each retry escalates the counter. This is the correct
//     policy: a failed Stripe call may or may not have resulted in a charge-side
//     refund, so issuing a new idempotency key on retry is intentional — the
//     caller should verify the order state (charge.refunded webhook) before
//     retrying.
//
// REVERSAL ALGORITHM (balanced, cents-exact):
//   1. Load the order's CREDIT-side sale ledger entries (stripe_fee,
//      platform_revenue, photographer 'sale' credits) filtered by
//      refundId IS NULL. Their amountCents are the weights [w_1..w_k].
//   2. allocateProportional(R, weights) -> shares[] that sum exactly to R.
//   3. For each credit-side entry: emit a DEBIT of shares[i] against the same
//      account (claws back proportionally; for photographers this reduces what
//      we owe them).
//   4. Emit a single platform_cash CREDIT of R (mirrors cash returned to buyer).
//   5. Balance: SUM(debits) = SUM(shares) = R = platform_cash credit R. QED.
//
// MISSING SALE ENTRIES:
//   If no sale ledger entries exist for the order (e.g. ledger was not posted
//   yet), the Stripe refund and status updates still proceed. The ledger batch
//   is SKIPPED and a stderr warning is emitted. The reconcile/backfill via
//   reconcileRefundFromWebhook is the accepted recovery path.

import type { DbClient } from '@pkg/db';

import { writeAudit } from '../lib/audit.js';
import { sendMail } from '../lib/email.js';
import {
  type LedgerEntryInput,
  allocateProportional,
  getPlatformAccountId,
  postLedgerBatch,
} from './ledger.js';

// ---------- Error ----------

export class AdminRefundError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_decision'
      | 'invalid_amount'
      | 'already_decided'
      | 'no_charge'
      | 'stripe_error',
    message: string,
  ) {
    super(message);
    this.name = 'AdminRefundError';
  }
}

// ---------- Seam types ----------

// Narrow seam so tests do not need to instantiate a full Stripe client.
export interface StripeRefundClient {
  refunds: {
    create(
      params: { charge: string; amount: number },
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>;
  };
}

export type MailerFn = typeof import('../lib/email.js').sendMail;

// ---------- Input / output types ----------

export interface RefundDecisionInput {
  decision: 'approve' | 'deny';
  amountCents?: number;
  adminNote?: string;
}

export interface RefundDecisionResult {
  status: string;
  stripeRefundId?: string;
  refundedCents: number;
}

// ---------- Internal row shapes ----------

interface OrderRow {
  id: string;
  buyerEmail: string;
  buyerUserId: string | null;
  totalCents: number;
  refundedCents: number;
  currency: string;
  stripeChargeId: string | null;
  status: string;
}

interface RefundRequestRow {
  id: string;
  orderId: string;
  buyerId: string | null;
  status: string;
  refundAttempts: number;
  stripeRefundId: string | null;
  approvedAmountCents: number | null;
  adminNote: string | null;
}

interface SaleLedgerRow {
  id: string;
  accountId: string;
  direction: string;
  amountCents: number;
  currency: string;
  kind: string;
}

// ---------- Helpers ----------

const DECIDED_STATUSES = new Set(['denied', 'processed']);

// ---------- decideRefund ----------

export const decideRefund = async (
  db: DbClient,
  refundRequestId: string,
  input: RefundDecisionInput,
  ctx: { adminUserId: string },
  stripeClient?: StripeRefundClient,
  mailer?: MailerFn,
): Promise<RefundDecisionResult> => {
  const { schema } = await import('@pkg/db');
  const { eq, isNull, and, inArray } = await import('drizzle-orm');

  const { orders, refundRequests } = schema.commerce.tables;
  const { ledgerEntries } = schema.payouts.tables;

  const mail = mailer ?? sendMail;

  // 1. Load refund_request.
  const rrRows = await db
    .select()
    .from(refundRequests)
    .where(eq(refundRequests.id, refundRequestId))
    .limit(1);
  const rr = rrRows[0] as RefundRequestRow | undefined;
  if (!rr) {
    throw new AdminRefundError('not_found', 'refund request not found');
  }

  // 2. Guard against re-deciding.
  if (DECIDED_STATUSES.has(rr.status)) {
    throw new AdminRefundError('already_decided', `refund request is already ${rr.status}`);
  }

  // 3. Load order.
  const orderRows = await db.select().from(orders).where(eq(orders.id, rr.orderId)).limit(1);
  const order = orderRows[0] as OrderRow | undefined;
  if (!order) {
    throw new AdminRefundError('not_found', 'order not found');
  }

  // 4. Dispatch.
  if (input.decision === 'approve') {
    // ---- APPROVE ----

    // Resolve amount: default is full remaining balance.
    const remaining = order.totalCents - order.refundedCents;
    const amount = input.amountCents ?? remaining;

    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
      throw new AdminRefundError(
        'invalid_amount',
        `amountCents must be a positive integer <= remaining refundable amount (${remaining})`,
      );
    }

    if (!order.stripeChargeId) {
      throw new AdminRefundError('no_charge', 'order has no associated Stripe charge id');
    }

    // Compute idempotency key: stable within this invocation, changes on each retry.
    const attempt = rr.refundAttempts + 1;
    const idempotencyKey = `refund:${refundRequestId}:${attempt}`;

    // Persist incremented attempt count before calling Stripe so a crash
    // does not let the caller retry with the same attempt number.
    await db
      .update(refundRequests)
      .set({ refundAttempts: attempt, updatedAt: new Date() })
      .where(eq(refundRequests.id, refundRequestId));

    // Call Stripe.
    let stripeRefundId: string;
    try {
      const stripeInstance: StripeRefundClient =
        stripeClient ?? (await import('../lib/stripe.js')).stripe;
      const refund = await stripeInstance.refunds.create(
        { charge: order.stripeChargeId, amount },
        { idempotencyKey },
      );
      stripeRefundId = refund.id;
    } catch (err) {
      throw new AdminRefundError(
        'stripe_error',
        `Stripe refund failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Compute new refundedCents and order status.
    const newRefundedCents = order.refundedCents + amount;
    const newOrderStatus = newRefundedCents >= order.totalCents ? 'refunded' : 'partially_refunded';

    // Persist refund_request updates.
    await db
      .update(refundRequests)
      .set({
        status: 'processed',
        stripeRefundId,
        approvedAmountCents: amount,
        adminNote: input.adminNote ?? null,
        updatedAt: new Date(),
      })
      .where(eq(refundRequests.id, refundRequestId));

    // Persist order updates.
    await db
      .update(orders)
      .set({
        refundedCents: newRefundedCents,
        status: newOrderStatus,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));

    // ---- Reversal ledger batch ----

    // Load CREDIT-side sale entries for this order (refundId IS NULL).
    const saleCreditRows = (await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.orderId, order.id),
          eq(ledgerEntries.direction, 'credit'),
          inArray(ledgerEntries.kind, ['stripe_fee', 'platform_fee', 'sale']),
          isNull(ledgerEntries.refundId),
        ),
      )) as SaleLedgerRow[];

    if (saleCreditRows.length === 0) {
      // No sale ledger entries yet — skip reversal. The webhook reconcile is
      // the accepted backstop. This is documented at the top of this file.
      process.stderr.write(
        `[admin-refunds] no sale ledger entries for order ${order.id}; skipping reversal batch. reconcileRefundFromWebhook will backfill.\n`,
      );
    } else {
      const weights = saleCreditRows.map((r) => r.amountCents);
      const shares = allocateProportional(amount, weights);

      const platformCashAccountId = await getPlatformAccountId(db, 'platform_cash');

      const currency = order.currency;
      const reversalEntries: LedgerEntryInput[] = [];

      // DEBIT each credit-side sale account proportionally.
      for (let i = 0; i < saleCreditRows.length; i++) {
        const row = saleCreditRows[i];
        const share = shares[i];
        if (!row || share === undefined) continue;
        if (share <= 0) continue; // skip zero-cent allocations (e.g. rounding edge)
        reversalEntries.push({
          accountId: row.accountId,
          direction: 'debit',
          amountCents: share,
          currency,
          kind: 'refund',
          memo: `refund clawback for refund request ${refundRequestId}`,
          orderId: order.id,
          refundId: refundRequestId,
        });
      }

      // CREDIT platform_cash for the cash returned to the buyer.
      // This mirrors the DEBIT that was posted at sale time.
      reversalEntries.push({
        accountId: platformCashAccountId,
        direction: 'credit',
        amountCents: amount,
        currency,
        kind: 'refund',
        memo: `cash refunded to buyer for refund request ${refundRequestId}`,
        orderId: order.id,
        refundId: refundRequestId,
      });

      await postLedgerBatch(db, reversalEntries);
    }

    // Audit.
    await writeAudit(db, {
      action: 'order.refund.approved',
      actorKind: 'admin',
      actorUserId: ctx.adminUserId,
      targetKind: 'refund_request',
      targetId: refundRequestId,
      payload: {
        orderId: order.id,
        amountCents: amount,
        stripeRefundId,
        newRefundedCents,
        newOrderStatus,
      },
    });

    return {
      status: 'processed',
      stripeRefundId,
      refundedCents: newRefundedCents,
    };
  }

  if (input.decision === 'deny') {
    // ---- DENY ----

    await db
      .update(refundRequests)
      .set({
        status: 'denied',
        adminNote: input.adminNote ?? null,
        updatedAt: new Date(),
      })
      .where(eq(refundRequests.id, refundRequestId));

    // Best-effort buyer notification — never throws.
    await mail({
      to: order.buyerEmail,
      subject: 'Your refund request has been reviewed',
      text: [
        'Thank you for contacting us.',
        'After reviewing your refund request, we are unable to approve it at this time.',
        input.adminNote ? `Note from our team: ${input.adminNote}` : '',
        `Order reference: ${order.id}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      html: [
        '<p>Thank you for contacting us.</p>',
        '<p>After reviewing your refund request, we are unable to approve it at this time.</p>',
        input.adminNote ? `<p><strong>Note from our team:</strong> ${input.adminNote}</p>` : '',
        `<p>Order reference: <code>${order.id}</code></p>`,
      ]
        .filter(Boolean)
        .join(''),
    }).catch((err: unknown) => {
      process.stderr.write(
        `[admin-refunds] buyer denial notification failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });

    // Audit.
    await writeAudit(db, {
      action: 'order.refund.denied',
      actorKind: 'admin',
      actorUserId: ctx.adminUserId,
      targetKind: 'refund_request',
      targetId: refundRequestId,
      payload: {
        orderId: order.id,
        adminNote: input.adminNote ?? null,
      },
    });

    return {
      status: 'denied',
      refundedCents: order.refundedCents,
    };
  }

  // Exhaustive guard — TypeScript should prevent this.
  throw new AdminRefundError('invalid_decision', `unknown decision: ${String(input.decision)}`);
};

// ---------- reconcileRefundFromWebhook ----------

/**
 * Idempotent backstop called from the charge.refunded webhook (or backfill).
 * Sets order.refundedCents = charge.amount_refunded and adjusts status.
 * If a processed refund_request exists without a ledger reversal, the
 * caller's reconcile job (not this function) should re-post the ledger.
 * This function only handles the order-level status reconciliation.
 */
export const reconcileRefundFromWebhook = async (
  db: DbClient,
  charge: {
    id: string;
    payment_intent: string | null;
    amount_refunded: number;
    amount: number;
  },
): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const { eq } = await import('drizzle-orm');

  const { orders } = schema.commerce.tables;

  if (!charge.payment_intent) return;

  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.stripePaymentIntentId, charge.payment_intent))
    .limit(1);
  const order = orderRows[0] as OrderRow | undefined;
  if (!order) return;

  const refundedCents = charge.amount_refunded;
  const newStatus = refundedCents >= order.totalCents ? 'refunded' : 'partially_refunded';

  // Idempotent: only write if data actually changed.
  if (order.refundedCents === refundedCents && order.status === newStatus) return;

  await db
    .update(orders)
    .set({
      refundedCents,
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, order.id));
};
