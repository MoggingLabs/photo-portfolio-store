// F4.10 — print fulfillment worker sweeps (fake db, mock adapter).

import { beforeEach, describe, expect, it } from 'vitest';

import { MockPrintLabAdapter, PrintLabError } from '@pkg/integrations';

vi.mock('@pkg/db', () => ({
  schema: {
    print: {
      printLabOrders: {
        id: { column: 'id' },
        orderId: { column: 'orderId' },
        labCode: { column: 'labCode' },
        labOrderId: { column: 'labOrderId' },
        idempotencyKey: { column: 'idempotencyKey' },
        attempts: { column: 'attempts' },
        rawStateJson: { column: 'rawStateJson' },
        state: { column: 'state' },
        needsManualIntervention: { column: 'needsManualIntervention' },
        nextRetryAt: { column: 'nextRetryAt' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => {
  const noop = () => ({});
  return { and: noop, eq: noop, inArray: noop, isNotNull: noop, isNull: noop, lte: noop, or: noop };
});

import { vi } from 'vitest';

type Row = Record<string, unknown>;
let rows: Row[];

// Select returns all rows; the job filters in SQL (mocked noop) so we return the
// candidate set the job expects per sweep via a mode flag.
let selectMode: 'submit' | 'poll';

const makeDb = () => ({
  select: () => {
    const api = {
      from: () => api,
      where: () => api,
      limit: () =>
        Promise.resolve(
          selectMode === 'submit'
            ? rows.filter((r) => r.state === 'pending' && !r.needsManualIntervention)
            : rows.filter(
                (r) => (r.state === 'submitted' || r.state === 'in_production') && r.labOrderId,
              ),
        ),
    };
    return api;
  },
  update: () => ({
    set: (s: Row) => ({
      where: () => {
        // The job updates by id; we stamp the single in-flight row.
        const r = rows.find((x) => x.id === currentId);
        if (r) Object.assign(r, s);
        return { returning: () => Promise.resolve(r ? [{ id: r.id }] : []) };
      },
    }),
  }),
});
let currentId = '';

let job: typeof import('../src/jobs/print-fulfillment.js');
const NOW = new Date('2026-06-01T12:00:00Z');

beforeEach(async () => {
  rows = [];
  job = await import('../src/jobs/print-fulfillment.js');
});

describe('runPrintSubmissions', () => {
  it('submits a pending order and advances it to submitted', async () => {
    rows = [
      {
        id: 'l1',
        orderId: 'o1',
        labCode: 'mock',
        idempotencyKey: 'o1',
        attempts: 0,
        state: 'pending',
        needsManualIntervention: false,
        nextRetryAt: null,
        rawStateJson: {
          submitOrder: {
            orderUuid: 'o1',
            currency: 'USD',
            shippingAddress: {},
            items: [{ productCode: 'x', quantity: 1, assetUrl: 'https://a', colorProfile: 'sRGB' }],
          },
        },
      },
    ];
    currentId = 'l1';
    selectMode = 'submit';
    const adapter = new MockPrintLabAdapter({ labCode: 'mock' });
    const res = await job.runPrintSubmissions(makeDb() as never, {
      adapterResolver: () => adapter,
      now: () => NOW,
    });
    expect(res.submitted).toBe(1);
    expect(rows[0]?.state).toBe('submitted');
    expect(rows[0]?.labOrderId).toBeTruthy();
  });

  it('backs off a retryable lab error', async () => {
    rows = [
      {
        id: 'l1',
        labCode: 'mock',
        idempotencyKey: 'o1',
        attempts: 0,
        state: 'pending',
        needsManualIntervention: false,
        nextRetryAt: null,
        rawStateJson: { submitOrder: { items: [{}] } },
      },
    ];
    currentId = 'l1';
    selectMode = 'submit';
    const adapter = {
      labCode: 'mock',
      submit: async () => {
        throw new PrintLabError('rate_limited', 'slow down', true);
      },
      status: async () => ({ state: 'pending' as const }),
      cancel: async () => ({ cancelled: false }),
    };
    const res = await job.runPrintSubmissions(makeDb() as never, {
      adapterResolver: () => adapter,
      now: () => NOW,
    });
    expect(res.retried).toBe(1);
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.nextRetryAt).toEqual(new Date(NOW.getTime() + job.SUBMIT_RETRY_DELAYS_MS[0]));
  });

  it('flags manual intervention on a terminal error', async () => {
    rows = [
      {
        id: 'l1',
        labCode: 'mock',
        idempotencyKey: 'o1',
        attempts: 0,
        state: 'pending',
        needsManualIntervention: false,
        nextRetryAt: null,
        rawStateJson: { submitOrder: { items: [{}] } },
      },
    ];
    currentId = 'l1';
    selectMode = 'submit';
    const adapter = {
      labCode: 'mock',
      submit: async () => {
        throw new PrintLabError('invalid_order', 'bad', false);
      },
      status: async () => ({ state: 'pending' as const }),
      cancel: async () => ({ cancelled: false }),
    };
    const res = await job.runPrintSubmissions(makeDb() as never, {
      adapterResolver: () => adapter,
      now: () => NOW,
    });
    expect(res.manualIntervention).toBe(1);
    expect(rows[0]?.needsManualIntervention).toBe(true);
    expect(rows[0]?.state).toBe('failed');
  });

  it('skips when the lab is not configured (resolver returns null)', async () => {
    rows = [
      {
        id: 'l1',
        labCode: 'bayphoto',
        idempotencyKey: 'o1',
        attempts: 0,
        state: 'pending',
        needsManualIntervention: false,
        nextRetryAt: null,
        rawStateJson: { submitOrder: { items: [{}] } },
      },
    ];
    currentId = 'l1';
    selectMode = 'submit';
    const res = await job.runPrintSubmissions(makeDb() as never, {
      adapterResolver: () => null,
      now: () => NOW,
    });
    expect(res.processed).toBe(1);
    expect(res.submitted).toBe(0);
    expect(rows[0]?.state).toBe('pending');
  });
});

describe('runPrintStatusPolls', () => {
  it('updates state + tracking from the adapter status', async () => {
    const adapter = new MockPrintLabAdapter({ labCode: 'mock' });
    // seed the adapter so status(labOrderId) resolves to shipped+tracking
    const { labOrderId } = await adapter.submit(
      {
        orderUuid: 'o',
        currency: 'USD',
        shippingAddress: {} as never,
        items: [{ productCode: 'x', quantity: 1, assetUrl: 'https://a', colorProfile: 'sRGB' }],
      },
      'o',
    );
    adapter.setState(labOrderId, 'shipped', { carrier: 'DHL', number: '5', url: 'https://t' });
    rows = [{ id: 'l1', labCode: 'mock', labOrderId, state: 'submitted' }];
    currentId = 'l1';
    selectMode = 'poll';
    const res = await job.runPrintStatusPolls(makeDb() as never, {
      adapterResolver: () => adapter,
      now: () => NOW,
    });
    expect(res.updated).toBe(1);
    expect(rows[0]?.state).toBe('shipped');
    expect(rows[0]?.trackingCarrier).toBe('DHL');
  });
});
