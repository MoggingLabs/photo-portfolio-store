// F2.6 — Buyer self-service refund request service.
//
// Creates a pending refund_requests row for later admin review (F2.7).
// No money moves here. The partial unique index on (order_id, status IN
// ('pending','approved')) is the race backstop; the pre-check below is an
// optimistic fast path.
//
// REFUND_WINDOW_DAYS: currently a module-level constant. A future milestone
// may persist a per-event or global override in the database; callers should
// read this export rather than hard-coding 30.

import type { DbClient } from '@pkg/db';

import { writeAudit } from '../lib/audit.js';
import { sendMail } from '../lib/email.js';

// ---------- Constants ----------

/**
 * Number of days after payment (or placement for unpaid orders) within which
 * a buyer may submit a refund request. Can be made per-event in a later
 * milestone without changing the service interface.
 */
export const REFUND_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REASON_MAX_CHARS = 2000;

// ---------- Errors ----------

export class RefundServiceError extends Error {
  constructor(
    public readonly code:
      | 'order_not_found'
      | 'not_owner'
      | 'refund_window_expired'
      | 'refund_already_requested'
      | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'RefundServiceError';
  }
}

// ---------- Input / output types ----------

export interface CreateRefundRequestInput {
  orderId: string;
  reason: string;
  /** UUIDs of specific order items the buyer wants refunded. Defaults to []. */
  requestedItems?: string[];
}

export interface CreateRefundRequestContext {
  /** Authenticated user id — undefined for guest callers. */
  userId?: string;
  /** Buyer email for ownership check when userId is absent (guest flow). */
  buyerEmail?: string;
}

export interface CreateRefundRequestResult {
  refundRequestId: string;
  status: 'pending';
  createdAt: string;
}

// ---------- Internal row shapes ----------

interface OrderRow {
  id: string;
  buyerUserId: string | null;
  buyerEmail: string;
  paidAt: Date | null;
  placedAt: Date;
  status: string;
}

interface RefundRequestRow {
  id: string;
  status: string;
  reason: string;
  createdAt: Date;
}

export interface OrderView {
  id: string;
  buyerEmail: string;
  buyerUserId: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  status: string;
  placedAt: Date;
  paidAt: Date | null;
  refundRequest: {
    id: string;
    status: string;
    reason: string;
    createdAt: string;
  } | null;
}

// ---------- Helpers ----------

const isUniqueViolation = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  // Postgres unique violation code 23505.
  const asRecord = err as unknown as Record<string, unknown>;
  if (asRecord.code === '23505') return true;
  // Drizzle sometimes wraps the error; fall back to message inspection.
  return err.message.includes('unique') || err.message.includes('23505');
};

const daysSince = (date: Date, now: Date): number => (now.getTime() - date.getTime()) / MS_PER_DAY;

// ---------- createRefundRequest ----------

export const createRefundRequest = async (
  db: DbClient,
  input: CreateRefundRequestInput,
  ctx: CreateRefundRequestContext,
): Promise<CreateRefundRequestResult> => {
  const { schema } = await import('@pkg/db');
  const { eq, and, inArray } = await import('drizzle-orm');

  const { orders } = schema.commerce.tables;
  const { refundRequests } = schema.commerce.tables;

  // 1. Load order.
  const orderRows = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  const orderRow = orderRows[0] as OrderRow | undefined;
  if (!orderRow) {
    throw new RefundServiceError('order_not_found', 'order not found');
  }

  // 2. Ownership check.
  const ownedByUser = ctx.userId !== undefined && orderRow.buyerUserId === ctx.userId;
  const ownedByGuest =
    ctx.userId === undefined &&
    ctx.buyerEmail !== undefined &&
    orderRow.buyerEmail.toLowerCase() === ctx.buyerEmail.toLowerCase();
  if (!ownedByUser && !ownedByGuest) {
    throw new RefundServiceError('not_owner', 'order not found');
  }

  // 3. Refund window check.
  const anchor: Date = orderRow.paidAt ?? orderRow.placedAt;
  const now = new Date();
  if (daysSince(anchor, now) > REFUND_WINDOW_DAYS) {
    throw new RefundServiceError(
      'refund_window_expired',
      `refund window of ${REFUND_WINDOW_DAYS} days has passed`,
    );
  }

  // 4. Duplicate check (optimistic fast path — partial unique index is the race backstop).
  const activeRows = await db
    .select({ id: refundRequests.id, status: refundRequests.status })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.orderId, input.orderId),
        inArray(refundRequests.status, ['pending', 'approved']),
      ),
    )
    .limit(1);
  if (activeRows[0]) {
    throw new RefundServiceError(
      'refund_already_requested',
      'an active refund request already exists for this order',
    );
  }

  // 5. Insert row.
  const reason = input.reason.slice(0, REASON_MAX_CHARS);
  const requestedItems = input.requestedItems ?? [];

  let inserted: RefundRequestRow;
  try {
    const rows = await db
      .insert(refundRequests)
      .values({
        orderId: input.orderId,
        buyerId: ctx.userId ?? null,
        reason,
        requestedItems,
        status: 'pending',
        adminNote: null,
      })
      .returning();
    const row = rows[0] as RefundRequestRow | undefined;
    if (!row) throw new Error('refund_requests insert returned no row');
    inserted = row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new RefundServiceError(
        'refund_already_requested',
        'an active refund request already exists for this order',
      );
    }
    throw err;
  }

  // 6. Audit.
  await writeAudit(db, {
    action: 'order.refund.requested',
    actorKind: ctx.userId ? 'user' : 'system',
    actorUserId: ctx.userId,
    targetKind: 'refund_request',
    targetId: inserted.id,
    payload: {
      orderId: input.orderId,
      refundRequestId: inserted.id,
      reasonLength: reason.length,
    },
  });

  // 7. Admin notification — fires exactly once per new request.
  // Assumption: lib/email.ts only supports buyer-addressed mail (SendMailParams.to).
  // We send to the configured admin address via ADMIN_EMAIL env var; if absent we
  // fall back to MAIL_FROM so the dev-mode console-warn path in sendMail handles it
  // gracefully without throwing.
  const adminEmail = process.env.ADMIN_EMAIL ?? process.env.MAIL_FROM ?? 'admin@example.com';
  await sendMail({
    to: adminEmail,
    subject: `[Refund Request] Order ${input.orderId}`,
    text: [
      'A new refund request has been submitted.',
      `Order ID : ${input.orderId}`,
      `Request ID: ${inserted.id}`,
      `Buyer email: ${orderRow.buyerEmail}`,
      `Reason (${reason.length} chars): ${reason.slice(0, 200)}${reason.length > 200 ? '...' : ''}`,
    ].join('\n'),
    html: [
      '<p>A new refund request has been submitted.</p>',
      '<ul>',
      `<li><strong>Order ID:</strong> ${input.orderId}</li>`,
      `<li><strong>Request ID:</strong> ${inserted.id}</li>`,
      `<li><strong>Buyer email:</strong> ${orderRow.buyerEmail}</li>`,
      `<li><strong>Reason:</strong> ${reason.slice(0, 200)}${reason.length > 200 ? '...' : ''}</li>`,
      '</ul>',
    ].join(''),
  }).catch((err: unknown) => {
    // Admin notification failure must not block the buyer's confirmation.
    // The audit row above provides a durable record.
    // Using a local logger reference is unavailable in the service layer;
    // we surface it as a non-fatal process warning.
    process.stderr.write(
      `[refunds] admin notification failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });

  return {
    refundRequestId: inserted.id,
    status: 'pending',
    createdAt: (inserted.createdAt as Date).toISOString(),
  };
};

// ---------- getOrderWithRefund ----------

/**
 * Load an order (with ownership check) and attach the latest active refund
 * request when present. Returns null if the order does not exist or the
 * caller does not own it.
 */
export const getOrderWithRefund = async (
  db: DbClient,
  orderId: string,
  ctx: CreateRefundRequestContext,
): Promise<OrderView | null> => {
  const { schema } = await import('@pkg/db');
  const { eq, and, inArray } = await import('drizzle-orm');

  const { orders } = schema.commerce.tables;
  const { refundRequests } = schema.commerce.tables;

  const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const orderRow = orderRows[0] as OrderRow | undefined;
  if (!orderRow) return null;

  // Ownership.
  const ownedByUser = ctx.userId !== undefined && orderRow.buyerUserId === ctx.userId;
  const ownedByGuest =
    ctx.userId === undefined &&
    ctx.buyerEmail !== undefined &&
    orderRow.buyerEmail.toLowerCase() === ctx.buyerEmail.toLowerCase();
  if (!ownedByUser && !ownedByGuest) return null;

  // Load latest active refund request.
  const rrRows = await db
    .select()
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.orderId, orderId),
        inArray(refundRequests.status, ['pending', 'approved']),
      ),
    )
    .limit(1);
  const rr = rrRows[0] as RefundRequestRow | undefined;

  return {
    id: orderRow.id,
    buyerEmail: orderRow.buyerEmail,
    buyerUserId: orderRow.buyerUserId,
    subtotalCents: (orderRow as unknown as Record<string, unknown>).subtotalCents as number,
    taxCents: (orderRow as unknown as Record<string, unknown>).taxCents as number,
    totalCents: (orderRow as unknown as Record<string, unknown>).totalCents as number,
    currency: (orderRow as unknown as Record<string, unknown>).currency as string,
    status: orderRow.status,
    placedAt: orderRow.placedAt,
    paidAt: orderRow.paidAt,
    refundRequest: rr
      ? {
          id: rr.id,
          status: rr.status,
          reason: rr.reason,
          createdAt: (rr.createdAt as Date).toISOString(),
        }
      : null,
  };
};
