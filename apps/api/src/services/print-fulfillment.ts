// F4.10 — print fulfillment (API side): create lab orders, operator views, and
// the inbound lab-webhook state update.
//
// The fulfillment worker (apps/worker) performs the actual lab submit/status
// HTTP. Here we (a) create the pending print_lab_orders row at checkout time
// (idempotent on (lab_code, order uuid); the assembled PrintOrder is stored in
// raw_state_json so the worker can submit without re-reading commerce), (b)
// expose owner-gated read + manual re-poll, and (c) apply an inbound webhook's
// state change after the route has validated its signature.

import { type DbClient, schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';

const { printLabOrders, printLabWebhookEvents } = schema.print;
const { orders } = schema.commerce;

type PrintDbState =
  | 'pending'
  | 'submitted'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed';

// Lab status string -> our print_lab_order_state.
const LAB_STATE_MAP: Record<string, PrintDbState> = {
  pending: 'submitted',
  in_production: 'in_production',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  failed: 'failed',
};

export class FulfillmentError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'FulfillmentError';
  }
}

export interface CreatePrintLabOrderInput {
  orderId: string;
  labCode: string;
  // The fully-assembled PrintOrder payload (currency, address, signed items).
  printOrder: Record<string, unknown>;
}

// Idempotent on (lab_code, order id). Returns the row id (existing or new).
export const createPrintLabOrder = async (
  db: DbClient,
  input: CreatePrintLabOrderInput,
): Promise<{ id: string; created: boolean }> => {
  const inserted = await db
    .insert(printLabOrders)
    .values({
      orderId: input.orderId,
      labCode: input.labCode,
      idempotencyKey: input.orderId,
      state: 'pending',
      rawStateJson: { submitOrder: input.printOrder },
    })
    .onConflictDoNothing({ target: [printLabOrders.labCode, printLabOrders.idempotencyKey] })
    .returning({ id: printLabOrders.id });
  const row = inserted[0];
  if (row) return { id: row.id, created: true };

  const existing = await db
    .select({ id: printLabOrders.id })
    .from(printLabOrders)
    .where(
      and(
        eq(printLabOrders.labCode, input.labCode),
        eq(printLabOrders.idempotencyKey, input.orderId),
      ),
    )
    .limit(1);
  const ex = existing[0];
  if (!ex) throw new Error('print_lab_orders upsert returned no row');
  return { id: ex.id, created: false };
};

export interface FulfillmentView {
  orderId: string;
  labOrders: Array<{
    id: string;
    labCode: string;
    labOrderId: string | null;
    state: string;
    tracking: { carrier: string; number: string; url: string } | null;
    needsManualIntervention: boolean;
    lastStatusAt: string | null;
  }>;
}

const assertOwnsOrder = async (db: DbClient, orderId: string, userId: string): Promise<void> => {
  const rows = await db
    .select({ buyerUserId: orders.buyerUserId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const row = rows[0];
  // Anti-enumeration: same not_found for missing + not-owned.
  if (!row || row.buyerUserId !== userId)
    throw new FulfillmentError('not_found', 'order not found');
};

export const getFulfillment = async (
  db: DbClient,
  orderId: string,
  userId: string,
): Promise<FulfillmentView> => {
  await assertOwnsOrder(db, orderId, userId);
  const rows = await db
    .select({
      id: printLabOrders.id,
      labCode: printLabOrders.labCode,
      labOrderId: printLabOrders.labOrderId,
      state: printLabOrders.state,
      trackingCarrier: printLabOrders.trackingCarrier,
      trackingNumber: printLabOrders.trackingNumber,
      trackingUrl: printLabOrders.trackingUrl,
      needsManualIntervention: printLabOrders.needsManualIntervention,
      lastStatusAt: printLabOrders.lastStatusAt,
    })
    .from(printLabOrders)
    .where(eq(printLabOrders.orderId, orderId));
  return {
    orderId,
    labOrders: rows.map((r) => ({
      id: r.id,
      labCode: r.labCode,
      labOrderId: r.labOrderId,
      state: r.state,
      tracking:
        r.trackingCarrier && r.trackingNumber && r.trackingUrl
          ? { carrier: r.trackingCarrier, number: r.trackingNumber, url: r.trackingUrl }
          : null,
      needsManualIntervention: r.needsManualIntervention,
      lastStatusAt: r.lastStatusAt ? r.lastStatusAt.toISOString() : null,
    })),
  };
};

// Manual re-poll: nudge the order's lab orders so the worker's next status
// sweep re-checks them (the API stays free of lab HTTP).
export const requestPoll = async (
  db: DbClient,
  orderId: string,
  userId: string,
): Promise<{ requeued: number }> => {
  await assertOwnsOrder(db, orderId, userId);
  const updated = await db
    .update(printLabOrders)
    .set({ nextRetryAt: new Date(), updatedAt: new Date() })
    .where(eq(printLabOrders.orderId, orderId))
    .returning({ id: printLabOrders.id });
  return { requeued: updated.length };
};

export interface LabWebhookEvent {
  labCode: string;
  webhookId: string;
  labOrderId: string;
  status: string;
  tracking?: { carrier: string; number: string; url: string };
  signatureValid: boolean;
}

export interface ApplyWebhookResult {
  processed: boolean;
  reason?: 'duplicate' | 'invalid_signature' | 'unknown_lab_order';
  newState?: string;
}

// Record the inbound event (deduped on (lab_code, webhook_id)) and, when it is
// new + signature-valid, apply the state/tracking change to the lab order.
// Returns processed=false (idempotent) for a duplicate or invalid signature.
export const applyWebhookEvent = async (
  db: DbClient,
  evt: LabWebhookEvent,
  payload: Record<string, unknown>,
): Promise<ApplyWebhookResult> => {
  const inserted = await db
    .insert(printLabWebhookEvents)
    .values({
      labCode: evt.labCode,
      webhookId: evt.webhookId,
      signatureValid: evt.signatureValid,
      payloadJson: payload,
    })
    .onConflictDoNothing({
      target: [printLabWebhookEvents.labCode, printLabWebhookEvents.webhookId],
    })
    .returning({ id: printLabWebhookEvents.id });
  if (inserted.length === 0) return { processed: false, reason: 'duplicate' };

  if (!evt.signatureValid) return { processed: false, reason: 'invalid_signature' };

  const mapped = LAB_STATE_MAP[evt.status.toLowerCase()];
  if (!mapped) return { processed: false, reason: 'unknown_lab_order' };

  const now = new Date();
  const updated = await db
    .update(printLabOrders)
    .set({
      state: mapped,
      ...(evt.tracking
        ? {
            trackingCarrier: evt.tracking.carrier,
            trackingNumber: evt.tracking.number,
            trackingUrl: evt.tracking.url,
          }
        : {}),
      lastStatusAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(printLabOrders.labCode, evt.labCode), eq(printLabOrders.labOrderId, evt.labOrderId)),
    )
    .returning({ id: printLabOrders.id });

  await db
    .update(printLabWebhookEvents)
    .set({ processedAt: now })
    .where(
      and(
        eq(printLabWebhookEvents.labCode, evt.labCode),
        eq(printLabWebhookEvents.webhookId, evt.webhookId),
      ),
    );

  if (updated.length === 0) return { processed: false, reason: 'unknown_lab_order' };
  // NOTE: customer "shipped/delivered" notification is fired via the
  // notification system (F4.12), not from here. Wire when F4.12 lands.
  return { processed: true, newState: mapped };
};
