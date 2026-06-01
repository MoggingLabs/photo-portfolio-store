// F4.9 — print-lab adapter interface.
//
// The commerce layer routes print orders to a lab via a PrintLabAdapter so it
// stays decoupled from any specific lab (Bay Photo, WHCC, Miller's, Mpix). The
// interface is the contract every lab implementation must satisfy; the mock
// adapter exercises it in tests and the Bay Photo adapter is the reference
// implementation.

export type LabOrderState =
  | 'pending'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export type ColorProfile = 'sRGB' | 'AdobeRGB';

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface PrintOrderItem {
  // Lab-specific product/size code (e.g. an 8x10 luster print).
  productCode: string;
  quantity: number;
  // Signed asset URL valid for >= 7 days so the lab can fetch the source.
  assetUrl: string;
  colorProfile: ColorProfile;
  // Optional crop instructions in normalized [0,1] coordinates.
  crop?: { x: number; y: number; width: number; height: number };
}

export interface PrintOrder {
  // Client-side idempotency key (the commerce order uuid).
  orderUuid: string;
  currency: string; // ISO 4217
  shippingAddress: ShippingAddress;
  items: PrintOrderItem[];
}

export interface SubmitResult {
  labOrderId: string;
  estimatedShipDate?: Date;
}

export interface Tracking {
  carrier: string;
  number: string;
  url: string;
}

export interface StatusResult {
  state: LabOrderState;
  tracking?: Tracking;
}

export interface CancelResult {
  cancelled: boolean;
  reason?: string;
}

export type LabErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'not_found'
  | 'not_cancellable'
  | 'invalid_order'
  | 'transient';

export class PrintLabError extends Error {
  constructor(
    public readonly code: LabErrorCode,
    message: string,
    // Retryable errors (transient / rate_limited) should be retried with
    // backoff by the fulfillment worker; others are terminal.
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'PrintLabError';
  }
}

export interface PrintLabAdapter {
  readonly labCode: string;
  // Idempotent on `idempotencyKey` (the order uuid): a duplicate submit returns
  // the existing lab order rather than creating a second one.
  submit(order: PrintOrder, idempotencyKey: string): Promise<SubmitResult>;
  status(labOrderId: string): Promise<StatusResult>;
  cancel(labOrderId: string): Promise<CancelResult>;
}
