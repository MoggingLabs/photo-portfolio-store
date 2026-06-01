// F4.9 — Bay Photo reference print-lab adapter.
//
// Maps the PrintLabAdapter contract onto Bay Photo's REST API. The HTTP client
// is injectable so this is unit-testable against recorded fixtures without a
// live account. NOTE: the exact request/response shapes below follow Bay Photo's
// published API conventions but have NOT been verified against a live sandbox in
// this environment — treat the field mapping as the integration point to
// confirm during onboarding. Auth is an API key (stored encrypted via F4.1) sent
// in the Authorization header.

import {
  type CancelResult,
  type LabOrderState,
  type PrintLabAdapter,
  PrintLabError,
  type PrintOrder,
  type StatusResult,
  type SubmitResult,
} from './types.js';

export interface LabHttpResponse {
  status: number;
  body: unknown;
}

export type LabHttpClient = (
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
) => Promise<LabHttpResponse>;

export interface BayPhotoOptions {
  apiKey: string;
  baseUrl?: string;
  httpClient: LabHttpClient;
}

const DEFAULT_BASE_URL = 'https://api.bayphoto.com/v1';

// Bay Photo status string -> our normalized state.
const STATE_MAP: Record<string, LabOrderState> = {
  received: 'pending',
  pending: 'pending',
  in_production: 'in_production',
  printing: 'in_production',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  failed: 'failed',
  error: 'failed',
};

const mapState = (raw: unknown): LabOrderState => {
  const key = typeof raw === 'string' ? raw.toLowerCase() : '';
  return STATE_MAP[key] ?? 'pending';
};

const errorForStatus = (status: number, message: string): PrintLabError => {
  if (status === 401 || status === 403) return new PrintLabError('auth', message);
  if (status === 404) return new PrintLabError('not_found', message);
  if (status === 409) return new PrintLabError('not_cancellable', message);
  if (status === 422) return new PrintLabError('invalid_order', message);
  if (status === 429) return new PrintLabError('rate_limited', message, true);
  if (status >= 500) return new PrintLabError('transient', message, true);
  return new PrintLabError('invalid_order', message);
};

export class BayPhotoAdapter implements PrintLabAdapter {
  readonly labCode = 'bayphoto';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: LabHttpClient;

  constructor(opts: BayPhotoOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.http = opts.httpClient;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  async submit(order: PrintOrder, idempotencyKey: string): Promise<SubmitResult> {
    if (order.items.length === 0) throw new PrintLabError('invalid_order', 'order has no items');
    const payload = {
      idempotency_key: idempotencyKey,
      currency: order.currency,
      ship_to: order.shippingAddress,
      line_items: order.items.map((i) => ({
        product_code: i.productCode,
        quantity: i.quantity,
        asset_url: i.assetUrl,
        color_profile: i.colorProfile,
        crop: i.crop ?? null,
      })),
    };
    const res = await this.http('POST', `${this.baseUrl}/orders`, this.headers(), payload);
    if (res.status !== 200 && res.status !== 201) {
      throw errorForStatus(res.status, `bayphoto submit failed (${res.status})`);
    }
    const data = (res.body ?? {}) as { id?: string; estimated_ship_date?: string };
    if (!data.id)
      throw new PrintLabError('transient', 'bayphoto submit returned no order id', true);
    return {
      labOrderId: data.id,
      ...(data.estimated_ship_date
        ? { estimatedShipDate: new Date(data.estimated_ship_date) }
        : {}),
    };
  }

  async status(labOrderId: string): Promise<StatusResult> {
    const res = await this.http('GET', `${this.baseUrl}/orders/${labOrderId}`, this.headers());
    if (res.status !== 200)
      throw errorForStatus(res.status, `bayphoto status failed (${res.status})`);
    const data = (res.body ?? {}) as {
      status?: string;
      tracking?: { carrier?: string; number?: string; url?: string };
    };
    const state = mapState(data.status);
    const t = data.tracking;
    if (t?.carrier && t.number && t.url) {
      return { state, tracking: { carrier: t.carrier, number: t.number, url: t.url } };
    }
    return { state };
  }

  async cancel(labOrderId: string): Promise<CancelResult> {
    const res = await this.http(
      'POST',
      `${this.baseUrl}/orders/${labOrderId}/cancel`,
      this.headers(),
    );
    if (res.status === 200) {
      const data = (res.body ?? {}) as { cancelled?: boolean; reason?: string };
      return { cancelled: data.cancelled ?? true, ...(data.reason ? { reason: data.reason } : {}) };
    }
    if (res.status === 409) return { cancelled: false, reason: 'order can no longer be cancelled' };
    throw errorForStatus(res.status, `bayphoto cancel failed (${res.status})`);
  }
}
