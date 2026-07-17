"""Tracing client: batching, Basic auth, ingest envelope shapes, re-buffer on failure."""
from __future__ import annotations

import logging
import urllib.error

import pytest
from conftest import Capture, http_error

from memoturn import Memoturn
from memoturn.client import MASK_ERROR_SENTINEL

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def test_flush_posts_ingest_with_basic_auth(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    client.trace(name="t")
    client.flush()

    assert len(capture.requests) == 1
    assert capture.last.get_method() == "POST"
    assert capture.last.full_url == "http://api.test/v1/ingest"
    assert capture.headers()["content-type"] == "application/json"
    assert capture.basic_auth() == "pk-mt-x:sk-mt-y"
    assert isinstance(capture.body()["batch"], list)


def test_empty_flush_is_noop(capture: Capture) -> None:
    Memoturn(**CREDS).flush()
    assert capture.requests == []


def test_trace_envelope_shape(capture: Capture) -> None:
    client = Memoturn(**{**CREDS, "environment": "staging"})
    trace = client.trace(name="chat", userId="u1")
    client.flush()

    ev = _find(capture.batch(), "trace-create")
    assert isinstance(ev["id"], str) and isinstance(ev["timestamp"], str)
    assert ev["body"]["id"] == trace.id
    assert ev["body"]["name"] == "chat"
    assert ev["body"]["userId"] == "u1"
    assert ev["body"]["environment"] == "staging"


def test_generation_create_and_update(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    trace = client.trace()
    gen = trace.generation(name="llm", model="gpt-4o", provider="openai")
    gen.end(output={"text": "hi"}, usage={"totalTokens": 5})
    client.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["id"] == gen.id
    assert create["body"]["traceId"] == trace.id
    assert create["body"]["model"] == "gpt-4o"
    assert "startTime" in create["body"]
    assert update["body"]["id"] == gen.id
    assert "endTime" in update["body"]
    assert update["body"]["usage"] == {"totalTokens": 5}


def test_nested_span_parent_id(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    trace = client.trace()
    parent = trace.span(name="outer")
    child = parent.span(name="inner")
    client.flush()

    inner = next(e for e in capture.batch() if e["body"]["id"] == child.id)
    assert inner["body"]["parentObservationId"] == parent.id
    assert inner["body"]["traceId"] == trace.id


def test_score_envelope(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    trace = client.trace()
    trace.score("quality", value=0.9, dataType="NUMERIC")
    client.flush()

    score = _find(capture.batch(), "score-create")
    assert score["body"]["name"] == "quality"
    assert score["body"]["value"] == 0.9
    assert score["body"]["traceId"] == trace.id


def test_auto_flush_at_threshold(capture: Capture) -> None:
    client = Memoturn(**{**CREDS, "flush_at": 2})
    client.trace()
    assert capture.requests == []
    client.trace()  # second event hits flush_at
    assert len(capture.requests) == 1


def test_rebuffer_and_raise_on_hard_failure(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    client.trace()
    capture.error = http_error(500, "boom")
    with pytest.raises(Exception):
        client.flush()

    # batch was put back; a clean retry sends it again
    capture.error = None
    client.flush()
    assert len(capture.requests) == 2
    assert capture.batch()[0]["type"] == "trace-create"


def test_urlerror_rebuffers_without_losing_the_batch(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    client.trace()
    capture.error = urllib.error.URLError("connection refused")
    with pytest.raises(urllib.error.URLError):
        client.flush()

    # the dequeued batch must survive a network failure
    capture.error = None
    client.flush()
    assert len(capture.requests) == 2
    assert capture.batch()[0]["type"] == "trace-create"


def test_permanent_4xx_drops_the_batch(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    client.trace()
    capture.error = http_error(401, "unauthorized")
    with pytest.raises(Exception):
        client.flush()

    # a permanent reject is not retried — the buffer stays empty
    capture.error = None
    client.flush()
    assert len(capture.requests) == 1


def test_auto_flush_failure_does_not_raise_into_user_code(capture: Capture) -> None:
    client = Memoturn(**{**CREDS, "flush_at": 1})
    capture.error = http_error(500, "boom")
    client.trace()  # size-trigger flush fails internally; must not raise here

    capture.error = None
    client.flush()
    assert len(capture.requests) == 2


def test_207_partial_rejects_are_logged(capture: Capture, caplog: pytest.LogCaptureFixture) -> None:
    client = Memoturn(**CREDS)
    client.trace()
    capture.status = 207
    capture.responder = lambda _req: {"errors": [{"id": "x", "error": "bad event"}]}
    with caplog.at_level(logging.WARNING, logger="memoturn"):
        client.flush()
    assert any("rejected at ingest" in r.getMessage() for r in caplog.records)


def test_buffer_cap_drops_new_events(capture: Capture) -> None:
    client = Memoturn(**{**CREDS, "max_buffer_size": 2})
    client.trace()
    client.trace()
    client.trace()  # third is dropped
    client.flush()
    assert len(capture.batch()) == 2


def test_mask_applied_to_input_output(capture: Capture) -> None:
    client = Memoturn(**CREDS, mask=lambda value, field, event_type: "[masked]" if field == "input" else value)
    client.trace(input={"ssn": "123-45-6789"}, output={"ok": True})
    client.flush()

    body = _find(capture.batch(), "trace-create")["body"]
    assert body["input"] == "[masked]"
    assert body["output"] == {"ok": True}


def test_mask_error_uses_sentinel_never_the_raw_value(capture: Capture) -> None:
    def boom(value, field, event_type):
        raise RuntimeError("mask bug")

    client = Memoturn(**CREDS, mask=boom)
    client.trace(input="raw secret")
    client.flush()
    assert _find(capture.batch(), "trace-create")["body"]["input"] == MASK_ERROR_SENTINEL


def test_children_inherit_per_trace_environment(capture: Capture) -> None:
    client = Memoturn(**{**CREDS, "environment": "default"})
    trace = client.trace(environment="prod")
    trace.span(name="child")
    trace.score("quality", value=1.0)
    client.flush()

    batch = capture.batch()
    assert _find(batch, "span-create")["body"]["environment"] == "prod"
    assert _find(batch, "score-create")["body"]["environment"] == "prod"


def test_insecure_http_warns_once_per_origin(capture: Capture, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="memoturn"):
        Memoturn(base_url="http://collector-a.example:9", public_key="pk", secret_key="sk")
        Memoturn(base_url="http://collector-a.example:9", public_key="pk", secret_key="sk")
    assert sum("cleartext http" in r.getMessage() for r in caplog.records) == 1


def test_shutdown_flushes_remaining_events(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    client.trace()
    client.shutdown()
    assert len(capture.requests) == 1
