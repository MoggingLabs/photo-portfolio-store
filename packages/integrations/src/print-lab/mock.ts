// F4.9 — in-memory mock print-lab adapter.
//
// Used in tests and local dev. Idempotent submit keyed on the order uuid, a
// deterministic state machine, and cancel that succeeds only before shipping.
// A scripted-response hook lets tests drive specific states / failures.

import {
  type CancelResult,
  type LabOrderState,
  type PrintLabAdapter,
  PrintLabError,
  type PrintOrder,
  type StatusResult,
  type SubmitResult,
  type Tracking,
} from './types.js';

interface MockRecord {
  labOrderId: string;
  orderUuid: string;
  state: LabOrderState;
  tracking?: Tracking;
}

export interface MockAdapterOptions {
  labCode?: string;
  // Deterministic id generator (tests inject a counter); defaults to a counter.
  idFactory?: (orderUuid: string) => string;
}

export class MockPrintLabAdapter implements PrintLabAdapter {
  readonly labCode: string;
  private readonly byKey = new Map<string, MockRecord>();
  private readonly byId = new Map<string, MockRecord>();
  private counter = 0;
  private readonly idFactory: (orderUuid: string) => string;

  constructor(opts: MockAdapterOptions = {}) {
    this.labCode = opts.labCode ?? 'mock';
    this.idFactory = opts.idFactory ?? (() => `mock_${++this.counter}`);
  }

  async submit(order: PrintOrder, idempotencyKey: string): Promise<SubmitResult> {
    if (order.items.length === 0) {
      throw new PrintLabError('invalid_order', 'order has no items');
    }
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return { labOrderId: existing.labOrderId };

    const labOrderId = this.idFactory(order.orderUuid);
    const record: MockRecord = { labOrderId, orderUuid: order.orderUuid, state: 'pending' };
    this.byKey.set(idempotencyKey, record);
    this.byId.set(labOrderId, record);
    return { labOrderId };
  }

  async status(labOrderId: string): Promise<StatusResult> {
    const record = this.byId.get(labOrderId);
    if (!record) throw new PrintLabError('not_found', `unknown lab order ${labOrderId}`);
    return record.tracking
      ? { state: record.state, tracking: record.tracking }
      : { state: record.state };
  }

  async cancel(labOrderId: string): Promise<CancelResult> {
    const record = this.byId.get(labOrderId);
    if (!record) throw new PrintLabError('not_found', `unknown lab order ${labOrderId}`);
    if (record.state === 'shipped' || record.state === 'delivered') {
      return { cancelled: false, reason: `cannot cancel a ${record.state} order` };
    }
    record.state = 'cancelled';
    return { cancelled: true };
  }

  // --- Test helpers (not part of the adapter interface) ---

  setState(labOrderId: string, state: LabOrderState, tracking?: Tracking): void {
    const record = this.byId.get(labOrderId);
    if (!record) throw new PrintLabError('not_found', `unknown lab order ${labOrderId}`);
    record.state = state;
    if (tracking) record.tracking = tracking;
  }
}
