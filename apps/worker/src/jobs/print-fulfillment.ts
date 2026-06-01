// F4.10 — print fulfillment worker.
//
// Two sweeps, both cron-driven:
//   runPrintSubmissions: pending print_lab_orders -> adapter.submit, persist the
//     lab order id, advance to 'submitted'. Retryable lab errors back off
//     (1m,5m,15m,1h,6h,24h); after MAX_ATTEMPTS the row is flagged for manual
//     intervention. Terminal errors fail the row.
//   runPrintStatusPolls: submitted/in_production rows -> adapter.status, update
//     state + tracking (a 6h fallback in case a webhook was missed; manual
//     re-poll nudges next_retry_at so the next sweep re-checks sooner).
//
// The adapter resolver is injected so the lab HTTP + credentials live at the
// edge and the sweeps are unit-testable with a mock adapter.

import { type DbClient, schema } from '@pkg/db';
import type { LabOrderState, PrintLabAdapter, PrintOrder } from '@pkg/integrations';
import { PrintLabError } from '@pkg/integrations';
import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';

const { printLabOrders } = schema.print;

export const SUBMIT_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];
export const MAX_SUBMIT_ATTEMPTS = SUBMIT_RETRY_DELAYS_MS.length;
const BATCH_LIMIT = 100;

type PrintDbState =
  | 'pending'
  | 'submitted'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed';

// Adapter LabOrderState -> DB print_lab_order_state (the row is already
// 'submitted' once it has a lab order id, so a lab 'pending' maps to that).
const POLL_STATE_MAP: Record<LabOrderState, PrintDbState> = {
  pending: 'submitted',
  in_production: 'in_production',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  failed: 'failed',
};

export type AdapterResolver = (labCode: string) => PrintLabAdapter | null;

export interface PrintFulfillmentDeps {
  adapterResolver: AdapterResolver;
  now?: () => Date;
}

export interface SubmissionResult {
  processed: number;
  submitted: number;
  retried: number;
  manualIntervention: number;
}

export const runPrintSubmissions = async (
  db: DbClient,
  deps: PrintFulfillmentDeps,
): Promise<SubmissionResult> => {
  const now = deps.now ?? (() => new Date());
  const nowTs = now();
  const rows = await db
    .select({
      id: printLabOrders.id,
      orderId: printLabOrders.orderId,
      labCode: printLabOrders.labCode,
      idempotencyKey: printLabOrders.idempotencyKey,
      attempts: printLabOrders.attempts,
      rawStateJson: printLabOrders.rawStateJson,
    })
    .from(printLabOrders)
    .where(
      and(
        eq(printLabOrders.state, 'pending'),
        eq(printLabOrders.needsManualIntervention, false),
        or(isNull(printLabOrders.nextRetryAt), lte(printLabOrders.nextRetryAt, nowTs)),
      ),
    )
    .limit(BATCH_LIMIT);

  const result: SubmissionResult = {
    processed: 0,
    submitted: 0,
    retried: 0,
    manualIntervention: 0,
  };

  for (const row of rows) {
    result.processed += 1;
    const adapter = deps.adapterResolver(row.labCode);
    if (!adapter) continue; // lab not configured; leave pending

    const submitOrder = (row.rawStateJson as { submitOrder?: PrintOrder } | null)?.submitOrder;
    if (!submitOrder) {
      await flagManual(db, row.id, now());
      result.manualIntervention += 1;
      continue;
    }

    try {
      const res = await adapter.submit(submitOrder, row.idempotencyKey);
      await db
        .update(printLabOrders)
        .set({
          labOrderId: res.labOrderId,
          state: 'submitted',
          lastStatusAt: now(),
          nextRetryAt: null,
          updatedAt: now(),
        })
        .where(eq(printLabOrders.id, row.id));
      result.submitted += 1;
    } catch (err) {
      const retryable = err instanceof PrintLabError && err.retryable;
      const attempts = row.attempts + 1;
      if (retryable && attempts < MAX_SUBMIT_ATTEMPTS) {
        const delay = SUBMIT_RETRY_DELAYS_MS[attempts - 1] ?? SUBMIT_RETRY_DELAYS_MS[0] ?? 60_000;
        await db
          .update(printLabOrders)
          .set({ attempts, nextRetryAt: new Date(now().getTime() + delay), updatedAt: now() })
          .where(eq(printLabOrders.id, row.id));
        result.retried += 1;
      } else {
        // Retries exhausted or a terminal error -> manual intervention.
        await db
          .update(printLabOrders)
          .set({
            attempts,
            needsManualIntervention: true,
            ...(retryable ? {} : { state: 'failed' }),
            updatedAt: now(),
          })
          .where(eq(printLabOrders.id, row.id));
        result.manualIntervention += 1;
      }
    }
  }

  return result;
};

export interface PollResult {
  processed: number;
  updated: number;
}

export const runPrintStatusPolls = async (
  db: DbClient,
  deps: PrintFulfillmentDeps,
): Promise<PollResult> => {
  const now = deps.now ?? (() => new Date());
  const rows = await db
    .select({
      id: printLabOrders.id,
      labCode: printLabOrders.labCode,
      labOrderId: printLabOrders.labOrderId,
    })
    .from(printLabOrders)
    .where(
      and(
        inArray(printLabOrders.state, ['submitted', 'in_production']),
        isNotNull(printLabOrders.labOrderId),
      ),
    )
    .limit(BATCH_LIMIT);

  const result: PollResult = { processed: 0, updated: 0 };
  for (const row of rows) {
    if (!row.labOrderId) continue;
    result.processed += 1;
    const adapter = deps.adapterResolver(row.labCode);
    if (!adapter) continue;
    try {
      const status = await adapter.status(row.labOrderId);
      await db
        .update(printLabOrders)
        .set({
          state: POLL_STATE_MAP[status.state],
          ...(status.tracking
            ? {
                trackingCarrier: status.tracking.carrier,
                trackingNumber: status.tracking.number,
                trackingUrl: status.tracking.url,
              }
            : {}),
          lastStatusAt: now(),
          nextRetryAt: null,
          updatedAt: now(),
        })
        .where(eq(printLabOrders.id, row.id));
      result.updated += 1;
    } catch {
      // Leave the row; the next sweep retries. Transient lab errors are common.
    }
  }
  return result;
};

const flagManual = (db: DbClient, id: string, now: Date): Promise<unknown> =>
  db
    .update(printLabOrders)
    .set({ needsManualIntervention: true, updatedAt: now })
    .where(eq(printLabOrders.id, id));
