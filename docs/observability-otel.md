# OpenTelemetry tracing

End-to-end traces from API → worker → inference service. Critical for debugging the multi-service pipeline.

## What's instrumented

- **apps/api** — `@opentelemetry/sdk-node` + auto-instrumentations (HTTP, Fastify, fs disabled to reduce noise).
- **apps/worker** — same Node SDK stack.
- **apps/inference** — `opentelemetry-instrumentation-fastapi` + OTLP/HTTP exporter.

All three services emit traces via the W3C tracecontext spec, so a request originating in the API and triggering a worker job that calls inference produces a single trace with linked spans.

## Enabling locally

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to a local OTLP collector. Two common choices:

```bash
# Jaeger all-in-one (UI on http://localhost:16686)
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest

# SigNoz (richer queries; see signoz.io docs)
```

Then in `.env.local`:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=api  # set per service: api | worker | inference
```

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (local dev default), all three services skip OTel initialization and incur zero overhead.

## Production

Set the envs in Doppler (per ADR-0003). Use a managed collector (Honeycomb, Grafana Cloud, SigNoz Cloud, etc.) or self-hosted OpenTelemetry Collector.

## Sampling

- Default: `parentbased_always_on` (everything).
- Override with `OTEL_TRACES_SAMPLER` + `OTEL_TRACES_SAMPLER_ARG` per the OTel spec.
- Recommended for production: `OTEL_TRACES_SAMPLER=traceidratio` with `OTEL_TRACES_SAMPLER_ARG=0.1` (10%).

## Service resource attributes

Each service sets `service.name` from `OTEL_SERVICE_NAME` and `service.version` from `SENTRY_RELEASE` (re-using the git SHA convention).

## Verification

After enabling: `curl localhost:4000/health` → open Jaeger UI → expect a single span named `GET /health` for service `api`.
