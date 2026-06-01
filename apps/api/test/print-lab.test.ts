// F4.9 — print-lab adapter interface + mock + Bay Photo reference tests.

import { describe, expect, it, vi } from 'vitest';

import {
  BayPhotoAdapter,
  type LabHttpClient,
  MockPrintLabAdapter,
  PrintLabError,
  type PrintOrder,
  isPrintLabCode,
} from '@pkg/integrations';

const order = (over: Partial<PrintOrder> = {}): PrintOrder => ({
  orderUuid: 'order-1',
  currency: 'USD',
  shippingAddress: {
    name: 'A',
    line1: '1 St',
    city: 'Town',
    region: 'CA',
    postalCode: '90001',
    country: 'US',
  },
  items: [
    { productCode: '8x10', quantity: 1, assetUrl: 'https://cdn/x.jpg', colorProfile: 'sRGB' },
  ],
  ...over,
});

describe('MockPrintLabAdapter', () => {
  it('submit is idempotent on the idempotency key', async () => {
    const lab = new MockPrintLabAdapter();
    const a = await lab.submit(order(), 'order-1');
    const b = await lab.submit(order(), 'order-1');
    expect(a.labOrderId).toBe(b.labOrderId);
  });

  it('rejects an order with no items', async () => {
    const lab = new MockPrintLabAdapter();
    await expect(lab.submit(order({ items: [] }), 'k')).rejects.toMatchObject({
      code: 'invalid_order',
    });
  });

  it('reports status and allows cancel before shipping', async () => {
    const lab = new MockPrintLabAdapter();
    const { labOrderId } = await lab.submit(order(), 'k');
    expect((await lab.status(labOrderId)).state).toBe('pending');
    const res = await lab.cancel(labOrderId);
    expect(res.cancelled).toBe(true);
    expect((await lab.status(labOrderId)).state).toBe('cancelled');
  });

  it('refuses to cancel a shipped order', async () => {
    const lab = new MockPrintLabAdapter();
    const { labOrderId } = await lab.submit(order(), 'k');
    lab.setState(labOrderId, 'shipped', { carrier: 'UPS', number: '1Z', url: 'https://t' });
    const res = await lab.cancel(labOrderId);
    expect(res.cancelled).toBe(false);
    expect((await lab.status(labOrderId)).tracking?.carrier).toBe('UPS');
  });

  it('throws not_found for an unknown lab order', async () => {
    const lab = new MockPrintLabAdapter();
    await expect(lab.status('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('BayPhotoAdapter', () => {
  const make = (http: LabHttpClient) =>
    new BayPhotoAdapter({ apiKey: 'k', httpClient: http, baseUrl: 'https://lab.test/v1' });

  it('submits and maps the lab order id + estimated ship date', async () => {
    const http = vi.fn(async () => ({
      status: 201,
      body: { id: 'bp_1', estimated_ship_date: '2026-06-10T00:00:00Z' },
    }));
    const res = await make(http).submit(order(), 'order-1');
    expect(res.labOrderId).toBe('bp_1');
    expect(res.estimatedShipDate).toEqual(new Date('2026-06-10T00:00:00Z'));
    // idempotency key forwarded.
    const [, , , body] = http.mock.calls[0] as [
      string,
      string,
      unknown,
      { idempotency_key: string },
    ];
    expect(body.idempotency_key).toBe('order-1');
  });

  it('maps lab status strings to normalized states + tracking', async () => {
    const http = vi.fn(async () => ({
      status: 200,
      body: { status: 'PRINTING', tracking: { carrier: 'FedEx', number: '99', url: 'https://t' } },
    }));
    const res = await make(http).status('bp_1');
    expect(res.state).toBe('in_production');
    expect(res.tracking?.carrier).toBe('FedEx');
  });

  it('maps auth + rate-limit + server errors to typed PrintLabError', async () => {
    const auth = make(vi.fn(async () => ({ status: 401, body: {} })));
    await expect(auth.status('x')).rejects.toMatchObject({ code: 'auth', retryable: false });
    const rl = make(vi.fn(async () => ({ status: 429, body: {} })));
    await expect(rl.status('x')).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    const srv = make(vi.fn(async () => ({ status: 503, body: {} })));
    await expect(srv.submit(order(), 'k')).rejects.toMatchObject({
      code: 'transient',
      retryable: true,
    });
  });

  it('returns cancelled=false (not an error) when the lab says 409', async () => {
    const res = await make(vi.fn(async () => ({ status: 409, body: {} }))).cancel('bp_1');
    expect(res.cancelled).toBe(false);
  });

  it('treats a missing order id in the submit response as transient', async () => {
    await expect(
      make(vi.fn(async () => ({ status: 200, body: {} }))).submit(order(), 'k'),
    ).rejects.toMatchObject({ code: 'transient', retryable: true });
  });
});

describe('isPrintLabCode', () => {
  it('recognizes known lab codes', () => {
    expect(isPrintLabCode('bayphoto')).toBe(true);
    expect(isPrintLabCode('whcc')).toBe(false);
  });

  it('PrintLabError carries a code + retryable flag', () => {
    const e = new PrintLabError('transient', 'x', true);
    expect(e.retryable).toBe(true);
  });
});
