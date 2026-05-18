import { describe, expect, it } from 'vitest';

describe('OpenTelemetry init (no-op path)', () => {
  it('loads instrument.ts without throwing when OTEL endpoint is unset', async () => {
    // OTEL_EXPORTER_OTLP_ENDPOINT is unset in the test environment by default,
    // so importing instrument.ts must not initialize the SDK or throw.
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const mod = await import('../src/instrument.js');
    expect(mod.otelSdk).toBeUndefined();
  });
});
