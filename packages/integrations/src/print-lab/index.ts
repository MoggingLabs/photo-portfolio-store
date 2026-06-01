// F4.9 — print-lab adapter public surface + registry.

export * from './types.js';
export { MockPrintLabAdapter, type MockAdapterOptions } from './mock.js';
export {
  BayPhotoAdapter,
  type BayPhotoOptions,
  type LabHttpClient,
  type LabHttpResponse,
} from './bayphoto.js';

export const PRINT_LAB_CODES = ['bayphoto'] as const;
export type PrintLabCode = (typeof PRINT_LAB_CODES)[number];

export const isPrintLabCode = (v: string): v is PrintLabCode =>
  (PRINT_LAB_CODES as readonly string[]).includes(v);
