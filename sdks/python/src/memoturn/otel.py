"""OpenTelemetry export helpers — point an existing OTel setup at memoturn.

memoturn's OTLP/HTTP receiver (`POST /v1/otel/v1/traces`) ingests standard OTel spans and
maps GenAI semantic-convention attributes (`gen_ai.*`) into traces + generations. These
helpers pre-wire the endpoint URL + Basic-auth header from your API keys, so an
OTel-standardized team keeps its instrumentation and gets first-party DX.

    # Zero-dependency: hand the config to any OTLP span exporter you already use.
    from memoturn.otel import otlp_config
    cfg = otlp_config()
    OTLPSpanExporter(endpoint=cfg["endpoint"], headers=cfg["headers"])

    # Or the one-liner (needs opentelemetry-exporter-otlp-proto-http installed):
    from memoturn.otel import span_processor
    provider.add_span_processor(span_processor())

Credentials resolve from arguments or the MEMOTURN_BASE_URL / MEMOTURN_PUBLIC_KEY /
MEMOTURN_SECRET_KEY env vars, matching the rest of the SDK.
"""
from __future__ import annotations

import base64
import os
from typing import Any, Optional


def otlp_config(*, base_url: Optional[str] = None, public_key: Optional[str] = None,
                secret_key: Optional[str] = None, headers: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """The endpoint + headers an OTLP/HTTP span exporter needs to send to memoturn.

    Returns {"endpoint": "<base>/v1/otel/v1/traces", "headers": {"Authorization": "Basic …", …}}.
    Dependency-free — pass it straight into your own OTLPSpanExporter.
    """
    base = (base_url or os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")).rstrip("/")
    pk = public_key or os.environ.get("MEMOTURN_PUBLIC_KEY", "")
    sk = secret_key or os.environ.get("MEMOTURN_SECRET_KEY", "")
    auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    return {
        "endpoint": f"{base}/v1/otel/v1/traces",
        "headers": {"Authorization": f"Basic {auth}", **(headers or {})},
    }


def span_exporter(**kwargs: Any) -> Any:
    """A configured OTLP/HTTP span exporter for memoturn.

    Requires `opentelemetry-exporter-otlp-proto-http`. Accepts the same keyword args as
    `otlp_config` (base_url / public_key / secret_key / headers).
    """
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    except ImportError as e:  # pragma: no cover - optional dependency
        raise ImportError(
            "memoturn.otel.span_exporter requires 'opentelemetry-exporter-otlp-proto-http' — "
            "install it to use the OTel exporter."
        ) from e
    cfg = otlp_config(**kwargs)
    return OTLPSpanExporter(endpoint=cfg["endpoint"], headers=cfg["headers"])


def span_processor(**kwargs: Any) -> Any:
    """A BatchSpanProcessor exporting to memoturn — add to your TracerProvider.

    Requires `opentelemetry-exporter-otlp-proto-http` and `opentelemetry-sdk`.
    """
    try:
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as e:  # pragma: no cover - optional dependency
        raise ImportError(
            "memoturn.otel.span_processor requires 'opentelemetry-sdk' — "
            "install it (or use span_exporter with your own SpanProcessor)."
        ) from e
    return BatchSpanProcessor(span_exporter(**kwargs))
