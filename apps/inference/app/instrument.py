"""Observability initialization. Both Sentry and OpenTelemetry are no-ops
when their respective env vars are unset (local dev default).
"""

import os

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration


def init_sentry() -> None:
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return
    sentry_sdk.init(
        dsn=dsn,
        release=os.getenv("SENTRY_RELEASE"),
        environment=os.getenv("NODE_ENV", "development"),
        traces_sample_rate=0.1 if os.getenv("NODE_ENV") == "production" else 1.0,
        send_default_pii=False,
        integrations=[FastApiIntegration()],
    )


def init_otel(app: object | None = None) -> None:
    """Initialize OpenTelemetry tracing.

    Imports are inside the function so the package is only required when
    OTEL_EXPORTER_OTLP_ENDPOINT is set.
    """
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    service_name = os.getenv("OTEL_SERVICE_NAME", "inference")
    service_version = os.getenv("SENTRY_RELEASE", "0.1.0")

    provider = TracerProvider(
        resource=Resource.create(
            {SERVICE_NAME: service_name, SERVICE_VERSION: service_version}
        )
    )
    exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    if app is not None:
        FastAPIInstrumentor.instrument_app(app)
