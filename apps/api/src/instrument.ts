// Initialize observability (Sentry + OpenTelemetry) BEFORE any other import
// that should be instrumented. Both are no-ops when their respective env
// vars are unset (local dev default).

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import * as Sentry from '@sentry/node';

// --- Sentry ---
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  const release = process.env.SENTRY_RELEASE;
  const environment = process.env.NODE_ENV ?? 'development';
  const tracesSampleRate = environment === 'production' ? 0.1 : 1.0;

  const initOptions: Sentry.NodeOptions = {
    dsn,
    environment,
    tracesSampleRate,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
      }
      return event;
    },
  };
  if (release) initOptions.release = release;
  Sentry.init(initOptions);
}

// --- OpenTelemetry ---
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
let otelSdk: NodeSDK | undefined;
if (otlpEndpoint) {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'api';
  otelSdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.SENTRY_RELEASE ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Mute noisy fs spans
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  otelSdk.start();

  const shutdown = async (): Promise<void> => {
    try {
      await otelSdk?.shutdown();
    } catch {
      // best-effort during shutdown
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { Sentry, otelSdk };
