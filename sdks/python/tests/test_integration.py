"""Env-gated integration tests against a running dev API.

Run with:

    MEMOTURN_INTEGRATION=1 uv run --extra dev pytest tests/test_integration.py -q

Requires the seeded dev stack (`bun run setup && bun run dev` at the repo root);
base URL and keys come from MEMOTURN_BASE_URL / MEMOTURN_PUBLIC_KEY /
MEMOTURN_SECRET_KEY, defaulting to the seeded dev project. Skipped entirely in
the normal unit-test run.
"""
from __future__ import annotations

import os
import urllib.error
import uuid

import pytest

from memoturn import Memoturn, add_dataset_items, check_guardrails, create_dataset, get_dataset, record_run

pytestmark = pytest.mark.skipif(
    os.environ.get("MEMOTURN_INTEGRATION") != "1",
    reason="set MEMOTURN_INTEGRATION=1 with a running dev API",
)

BASE_URL = os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")
PUBLIC_KEY = os.environ.get("MEMOTURN_PUBLIC_KEY", "pk-mt-dev")
SECRET_KEY = os.environ.get("MEMOTURN_SECRET_KEY", "sk-mt-dev")
CREDS = dict(base_url=BASE_URL, public_key=PUBLIC_KEY, secret_key=SECRET_KEY)


def _client(**overrides) -> Memoturn:
    return Memoturn(flush_at=1000, allow_insecure_http=True, **{**CREDS, **overrides})


def test_ingest_round_trip() -> None:
    mt = _client()
    trace = mt.trace(name=f"it-ingest-{uuid.uuid4()}", input={"q": "2+2?"})
    gen = trace.generation(name="answer", model="mock-model", input=[{"role": "user", "content": "2+2?"}])
    gen.end(output="4", usage={"promptTokens": 3, "completionTokens": 1, "totalTokens": 4})
    trace.score("integration-check", value=1.0)
    mt.flush()  # no exception = the batch was accepted (207 ack)


def test_dataset_lifecycle() -> None:
    name = f"it-ds-{uuid.uuid4()}"
    created = create_dataset(name, "integration test dataset", **CREDS)
    assert created

    items = [
        {"input": "what is 2+2?", "expectedOutput": "4"},
        {"input": "capital of France?", "expectedOutput": "Paris", "metadata": {"topic": "geo"}},
    ]
    add_dataset_items(name, items, **CREDS)

    ds = get_dataset(name, **CREDS)
    fetched = ds.get("items") or []
    assert len(fetched) == 2
    inputs = {i["input"] for i in fetched}
    assert inputs == {"what is 2+2?", "capital of France?"}

    # Link a real trace to one item.
    mt = _client()
    trace = mt.trace(name=f"it-run-{uuid.uuid4()}")
    trace.update(output="4")
    mt.flush()
    run = record_run(name, f"run-{uuid.uuid4()}", [{"datasetItemId": fetched[0]["id"], "traceId": trace.id}], **CREDS)
    assert run


def test_guardrails_verdict() -> None:
    result = check_guardrails("hello, integration test", **CREDS)
    assert result["verdict"] in {"allow", "redact", "block"}


def test_bad_credentials_flush_raises() -> None:
    mt = _client(public_key="pk-mt-wrong", secret_key="sk-mt-wrong")
    mt.trace(name=f"it-unauthorized-{uuid.uuid4()}")
    # Permanent 4xx: flush() raises and drops the batch (no retry), so the
    # atexit hook has nothing left to send.
    with pytest.raises(urllib.error.HTTPError):
        mt.flush()
