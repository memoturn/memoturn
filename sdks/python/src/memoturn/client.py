"""memoturn client — batches events and flushes to POST /v1/ingest.

Stdlib-only (urllib). Create trace/span/generation handles and call .end() as work
completes; the client handles ids, timestamps, batching, and Basic auth.
"""
from __future__ import annotations

import atexit
import base64
import datetime as _dt
import json
import logging
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Optional

logger = logging.getLogger("memoturn")

#: Value substituted when a user-supplied mask function raises — the event is never
#: dropped and the unmasked value is never sent.
MASK_ERROR_SENTINEL = "<memoturn: mask error>"

#: A redaction hook: ``mask(value, field, event_type)`` applied to the ``input``,
#: ``output``, and ``metadata`` fields of every event body before buffering.
MaskFunction = Callable[[Any, str, str], Any]

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_warned_origins: set[str] = set()


def _id() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    # ISO-8601 with millisecond precision + 'Z', matching the JS SDK.
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _truncate(text: str, max_len: int = 200) -> str:
    """Cap server-provided text embedded in errors/logs so messages stay bounded."""
    return text if len(text) <= max_len else text[:max_len] + "…"


def _is_transient(code: int) -> bool:
    """5xx and explicit backpressure/timeout statuses are worth retrying; other 4xx are permanent."""
    return code >= 500 or code in (408, 429)


def _env_int(name: str, default: int) -> int:
    try:
        n = int(os.environ.get(name, ""))
        return n if n > 0 else default
    except ValueError:
        return default


def _warn_if_insecure(base_url: str, allow: bool) -> None:
    """Warn once per origin when API keys would go over cleartext http to a non-local
    host. Never raises — plain-http LAN self-hosted deployments are legitimate; the
    escape hatch is ``allow_insecure_http`` or ``MEMOTURN_ALLOW_HTTP=1``."""
    if allow or os.environ.get("MEMOTURN_ALLOW_HTTP") == "1":
        return
    parts = urllib.parse.urlsplit(base_url)
    if parts.scheme != "http" or (parts.hostname or "") in _LOCAL_HOSTS:
        return
    origin = f"{parts.scheme}://{parts.netloc}"
    if origin in _warned_origins:
        return
    _warned_origins.add(origin)
    logger.warning(
        "memoturn: sending API keys over cleartext http to %s — use https or set allow_insecure_http",
        parts.netloc,
    )


class Memoturn:
    """Batching ingest client.

    Args:
        base_url: API origin (default ``MEMOTURN_BASE_URL`` or ``http://localhost:3001``).
        public_key / secret_key: API key pair (default ``MEMOTURN_PUBLIC_KEY`` / ``MEMOTURN_SECRET_KEY``).
        environment: default environment stamped on events (default ``MEMOTURN_ENVIRONMENT`` or ``default``).
        flush_at: flush when the buffer reaches this many events (default 20).
        max_buffer_size: hard cap on buffered events; incoming events are dropped with a
            one-time warning once reached (default 10000, or ``MEMOTURN_MAX_BUFFER_SIZE``).
        request_timeout: per-request timeout in seconds (default 10).
        mask: redaction hook ``mask(value, field, event_type)`` applied to the ``input``,
            ``output``, and ``metadata`` of every event before buffering.
        allow_insecure_http: suppress the cleartext-http warning for non-local base URLs.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        public_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        environment: Optional[str] = None,
        flush_at: int = 20,
        max_buffer_size: Optional[int] = None,
        request_timeout: float = 10.0,
        mask: Optional[MaskFunction] = None,
        allow_insecure_http: bool = False,
    ) -> None:
        self.base_url = (base_url or os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")).rstrip("/")
        self.public_key = public_key or os.environ.get("MEMOTURN_PUBLIC_KEY", "")
        self.secret_key = secret_key or os.environ.get("MEMOTURN_SECRET_KEY", "")
        self.environment = environment or os.environ.get("MEMOTURN_ENVIRONMENT", "default")
        self.flush_at = flush_at
        self.max_buffer_size = max_buffer_size or _env_int("MEMOTURN_MAX_BUFFER_SIZE", 10_000)
        self.request_timeout = request_timeout
        self._mask = mask
        self._buffer: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._warned_buffer_full = False

        _warn_if_insecure(self.base_url, allow_insecure_http)
        if not self.public_key and not self.secret_key:
            logger.warning(
                "memoturn: no API keys configured (pass public_key/secret_key or set "
                "MEMOTURN_PUBLIC_KEY / MEMOTURN_SECRET_KEY) — ingest will be unauthorized"
            )
        atexit.register(self._flush_quietly)

    # ── public API ────────────────────────────────────────────────────────────
    def trace(self, **body: Any) -> "Trace":
        """Start a trace. Returns a handle for adding child observations + scores."""
        tid = body.pop("id", None) or _id()
        env = body.setdefault("environment", self.environment)
        self._enqueue("trace-create", {**body, "id": tid})
        return Trace(self, tid, env)

    def flush(self) -> None:
        """Send all buffered events now.

        Raises on failure; a transient failure (network error, 5xx, 408, 429)
        re-buffers the batch first so nothing is lost, while a permanent reject
        (other 4xx) drops the batch — retrying it can never succeed.
        """
        self._flush(raise_on_error=True)

    def shutdown(self) -> None:
        """Flush and unregister the exit hook. Call before process exit."""
        atexit.unregister(self._flush_quietly)
        self.flush()

    # ── internal ──────────────────────────────────────────────────────────────
    def _flush_quietly(self) -> None:
        """Flush without raising — used by the size trigger and the atexit hook."""
        self._flush(raise_on_error=False)

    def _flush(self, raise_on_error: bool) -> None:
        with self._lock:
            batch, self._buffer = self._buffer, []
        if not batch:
            return
        auth = base64.b64encode(f"{self.public_key}:{self.secret_key}".encode()).decode()
        req = urllib.request.Request(
            f"{self.base_url}/v1/ingest",
            data=json.dumps({"batch": batch}, default=str).encode(),
            headers={"content-type": "application/json", "authorization": f"Basic {auth}"},
            method="POST",
        )
        try:
            res = urllib.request.urlopen(req, timeout=self.request_timeout)
            raw = res.read()
        except urllib.error.HTTPError as e:
            try:
                detail = _truncate(e.read().decode(errors="replace"))
            except Exception:
                detail = ""
            if _is_transient(e.code):
                self._rebuffer(batch)
                if raise_on_error:
                    raise
                logger.error("memoturn: ingest failed (%s), re-buffered %d event(s): %s", e.code, len(batch), detail)
            else:
                # Permanent reject (bad request/auth) — retrying can never succeed; drop the batch.
                logger.error("memoturn: dropping %d event(s) rejected at ingest: %s %s", len(batch), e.code, detail)
                if raise_on_error:
                    raise
            return
        except urllib.error.URLError as e:
            # Network failure (connection refused / DNS / TLS) — transient: re-buffer so
            # the batch is not lost.
            self._rebuffer(batch)
            if raise_on_error:
                raise
            logger.error("memoturn: ingest failed, re-buffered %d event(s): %s", len(batch), _truncate(str(e)))
            return

        # A 207 reports per-event results; surface rejected events instead of silently
        # dropping them (they are NOT retried — a schema reject is permanent).
        if getattr(res, "status", 200) == 207:
            try:
                errors = (json.loads(raw) or {}).get("errors") or []
            except Exception:
                errors = []
            if errors:
                logger.warning(
                    "memoturn: %d event(s) rejected at ingest — first: %s",
                    len(errors),
                    errors[0].get("error") or "invalid event",
                )

    def _rebuffer(self, batch: list[dict[str, Any]]) -> None:
        """Put a failed batch back ahead of newer events, keeping the newest up to the cap."""
        with self._lock:
            combined = batch + self._buffer
            overflow = len(combined) - self.max_buffer_size
            self._buffer = combined[overflow:] if overflow > 0 else combined
        if overflow > 0 and not self._warned_buffer_full:
            self._warned_buffer_full = True
            logger.warning(
                "memoturn: event buffer full (%d), dropped %d oldest event(s)", self.max_buffer_size, overflow
            )

    def _apply_mask(self, type_: str, body: dict[str, Any]) -> dict[str, Any]:
        if self._mask is None:
            return body
        out = dict(body)
        for field in ("input", "output", "metadata"):
            if field not in out or out[field] is None:
                continue
            try:
                out[field] = self._mask(out[field], field, type_)
            except Exception:
                # Never lose the event — and never leak the unmasked value.
                out[field] = MASK_ERROR_SENTINEL
        return out

    def _enqueue(self, type_: str, body: dict[str, Any]) -> None:
        event = {"id": _id(), "type": type_, "timestamp": _now(), "body": self._apply_mask(type_, body)}
        with self._lock:
            if len(self._buffer) >= self.max_buffer_size:
                dropped = True
            else:
                dropped = False
                self._buffer.append(event)
            should = not dropped and len(self._buffer) >= self.flush_at
        if dropped:
            if not self._warned_buffer_full:
                self._warned_buffer_full = True
                logger.warning(
                    "memoturn: event buffer full (%d), dropping new events — is the API reachable?",
                    self.max_buffer_size,
                )
            return
        if should:
            self._flush_quietly()


class Trace:
    """Handle for one trace; children inherit the trace's resolved environment."""

    def __init__(self, client: Memoturn, trace_id: str, environment: Optional[str] = None) -> None:
        self._c = client
        self.id = trace_id
        self._env = environment or client.environment

    def update(self, **body: Any) -> "Trace":
        self._c._enqueue("trace-create", {**body, "id": self.id, "environment": self._env})
        return self

    def span(self, **body: Any) -> "Span":
        return self._observe("span-create", "span", body)

    def generation(self, **body: Any) -> "Span":
        return self._observe("generation-create", "generation", body)

    def tool(self, **body: Any) -> "Span":
        """A tool-call span (classified TOOL)."""
        return self._observe("span-create", "span", {**body, "observationType": "TOOL"})

    def agent(self, **body: Any) -> "Span":
        """An agent-step span (classified AGENT)."""
        return self._observe("span-create", "span", {**body, "observationType": "AGENT"})

    def event(self, **body: Any) -> None:
        self._c._enqueue(
            "event-create",
            {**body, "id": body.pop("id", None) or _id(), "traceId": self.id,
             "environment": self._env, "startTime": _now()},
        )

    def score(self, name: str, value: Optional[float] = None, **body: Any) -> "Trace":
        self._c._enqueue(
            "score-create",
            {"id": _id(), "traceId": self.id, "name": name, "value": value,
             "environment": self._env, **body},
        )
        return self

    def _observe(self, type_: str, kind: str, body: dict[str, Any]) -> "Span":
        oid = body.pop("id", None) or _id()
        self._c._enqueue(
            type_,
            {**body, "id": oid, "traceId": self.id, "environment": self._env, "startTime": _now()},
        )
        return Span(self._c, self.id, oid, kind, self._env)


class Span:
    """Handle for one observation (span or generation)."""

    def __init__(self, client: Memoturn, trace_id: str, obs_id: str, kind: str,
                 environment: Optional[str] = None) -> None:
        self._c = client
        self._trace_id = trace_id
        self.id = obs_id
        self._kind = kind
        self._env = environment or client.environment

    def span(self, **body: Any) -> "Span":
        return self._child("span-create", "span", body)

    def generation(self, **body: Any) -> "Span":
        return self._child("generation-create", "generation", body)

    def tool(self, **body: Any) -> "Span":
        """Nested tool-call span (classified TOOL)."""
        return self._child("span-create", "span", {**body, "observationType": "TOOL"})

    def agent(self, **body: Any) -> "Span":
        """Nested agent-step span (classified AGENT)."""
        return self._child("span-create", "span", {**body, "observationType": "AGENT"})

    def _child(self, type_: str, kind: str, body: dict[str, Any]) -> "Span":
        oid = body.pop("id", None) or _id()
        self._c._enqueue(
            type_,
            {**body, "id": oid, "traceId": self._trace_id, "parentObservationId": self.id,
             "environment": self._env, "startTime": _now()},
        )
        return Span(self._c, self._trace_id, oid, kind, self._env)

    def end(self, **body: Any) -> None:
        type_ = "generation-update" if self._kind == "generation" else "span-update"
        self._c._enqueue(
            type_,
            {**body, "id": self.id, "traceId": self._trace_id, "environment": self._env, "endTime": _now()},
        )
