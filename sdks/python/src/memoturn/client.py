"""memoturn client — batches events and flushes to POST /v1/ingest.

Stdlib-only (urllib). Create trace/span/generation handles and call .end() as work
completes; the client handles ids, timestamps, batching, and Basic auth.
"""
from __future__ import annotations

import atexit
import base64
import datetime as _dt
import json
import os
import threading
import urllib.error
import urllib.request
import uuid
from typing import Any, Optional


def _id() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    # ISO-8601 with millisecond precision + 'Z', matching the JS SDK.
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Memoturn:
    def __init__(
        self,
        base_url: Optional[str] = None,
        public_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        environment: Optional[str] = None,
        flush_at: int = 20,
    ) -> None:
        self.base_url = (base_url or os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")).rstrip("/")
        self.public_key = public_key or os.environ.get("MEMOTURN_PUBLIC_KEY", "")
        self.secret_key = secret_key or os.environ.get("MEMOTURN_SECRET_KEY", "")
        self.environment = environment or os.environ.get("MEMOTURN_ENVIRONMENT", "default")
        self.flush_at = flush_at
        self._buffer: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        atexit.register(self.flush)

    # ── public API ────────────────────────────────────────────────────────────
    def trace(self, **body: Any) -> "Trace":
        tid = body.pop("id", None) or _id()
        body.setdefault("environment", self.environment)
        self._enqueue("trace-create", {**body, "id": tid})
        return Trace(self, tid)

    def flush(self) -> None:
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
            urllib.request.urlopen(req, timeout=10).read()
        except urllib.error.HTTPError as e:
            if e.code != 207:
                with self._lock:
                    self._buffer[0:0] = batch  # re-buffer for next flush
                raise

    def shutdown(self) -> None:
        self.flush()

    # ── internal ──────────────────────────────────────────────────────────────
    def _enqueue(self, type_: str, body: dict[str, Any]) -> None:
        with self._lock:
            self._buffer.append({"id": _id(), "type": type_, "timestamp": _now(), "body": body})
            should = len(self._buffer) >= self.flush_at
        if should:
            self.flush()


class Trace:
    def __init__(self, client: Memoturn, trace_id: str) -> None:
        self._c = client
        self.id = trace_id

    def update(self, **body: Any) -> "Trace":
        self._c._enqueue("trace-create", {**body, "id": self.id, "environment": self._c.environment})
        return self

    def span(self, **body: Any) -> "Span":
        return self._observe("span-create", "span", body)

    def generation(self, **body: Any) -> "Span":
        return self._observe("generation-create", "generation", body)

    def event(self, **body: Any) -> None:
        self._c._enqueue(
            "event-create",
            {**body, "id": body.pop("id", None) or _id(), "traceId": self.id,
             "environment": self._c.environment, "startTime": _now()},
        )

    def score(self, name: str, value: Optional[float] = None, **body: Any) -> "Trace":
        self._c._enqueue(
            "score-create",
            {"id": _id(), "traceId": self.id, "name": name, "value": value,
             "environment": self._c.environment, **body},
        )
        return self

    def _observe(self, type_: str, kind: str, body: dict[str, Any]) -> "Span":
        oid = body.pop("id", None) or _id()
        self._c._enqueue(
            type_,
            {**body, "id": oid, "traceId": self.id, "environment": self._c.environment, "startTime": _now()},
        )
        return Span(self._c, self.id, oid, kind)


class Span:
    def __init__(self, client: Memoturn, trace_id: str, obs_id: str, kind: str) -> None:
        self._c = client
        self._trace_id = trace_id
        self.id = obs_id
        self._kind = kind

    def span(self, **body: Any) -> "Span":
        return self._child("span-create", "span", body)

    def generation(self, **body: Any) -> "Span":
        return self._child("generation-create", "generation", body)

    def _child(self, type_: str, kind: str, body: dict[str, Any]) -> "Span":
        oid = body.pop("id", None) or _id()
        self._c._enqueue(
            type_,
            {**body, "id": oid, "traceId": self._trace_id, "parentObservationId": self.id,
             "environment": self._c.environment, "startTime": _now()},
        )
        return Span(self._c, self._trace_id, oid, kind)

    def end(self, **body: Any) -> None:
        type_ = "generation-update" if self._kind == "generation" else "span-update"
        self._c._enqueue(
            type_,
            {**body, "id": self.id, "traceId": self._trace_id, "environment": self._c.environment, "endTime": _now()},
        )
