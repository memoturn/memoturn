"""@observe builds a trace at the outermost call and nests inner calls as child spans."""
from __future__ import annotations

import pytest
from conftest import Capture

from memoturn import Memoturn, configure, observe

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _types(batch: list[dict]) -> list[str]:
    return [e["type"] for e in batch]


def test_root_creates_trace_with_nested_child(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    configure(client)

    @observe()
    def inner(x):
        return x + 1

    @observe(name="root")
    def outer(x):
        return inner(x) + inner(x)

    assert outer(1) == 4
    client.flush()

    batch = capture.batch()
    traces = [e for e in batch if e["type"] == "trace-create"]
    # one create for the root trace + one update() closing it
    assert len([e for e in traces if "output" not in e["body"]]) == 1
    trace_id = traces[0]["body"]["id"]

    creates = [e for e in batch if e["type"] == "span-create"]
    # root span + two inner spans, all on the same trace
    assert len(creates) == 3
    assert all(e["body"]["traceId"] == trace_id for e in creates)
    # the two inner spans are parented to the root span
    root_span_id = next(e["body"]["id"] for e in creates if e["body"].get("name") == "root")
    inner_spans = [e for e in creates if e["body"].get("name") == "inner"]
    assert all(e["body"]["parentObservationId"] == root_span_id for e in inner_spans)


def test_as_type_generation(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    configure(client)

    @observe(as_type="generation", name="llm-call")
    def call():
        return "ok"

    call()
    client.flush()
    assert "generation-create" in _types(capture.batch())


def test_error_path_records_error_and_reraises(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    configure(client)

    @observe()
    def boom():
        raise ValueError("nope")

    with pytest.raises(ValueError, match="nope"):
        boom()
    client.flush()

    end = next(e for e in capture.batch() if e["type"] == "span-update")
    assert end["body"]["level"] == "ERROR"
    assert "nope" in end["body"]["statusMessage"]
