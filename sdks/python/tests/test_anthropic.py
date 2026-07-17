"""wrap_anthropic records each messages.create call as a generation with mapped usage."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_anthropic

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_anthropic(create):
    return SimpleNamespace(messages=SimpleNamespace(create=create))


def _message(**usage_overrides):
    usage = SimpleNamespace(
        input_tokens=10,
        output_tokens=3,
        cache_read_input_tokens=7,
        cache_creation_input_tokens=2,
        **usage_overrides,
    )
    block = SimpleNamespace(model_dump=lambda: {"type": "text", "text": "4"})
    return SimpleNamespace(content=[block], usage=usage)


def test_records_generation_with_usage_and_cache_tokens(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    message = _message()
    client = _fake_anthropic(lambda **kw: message)
    wrap_anthropic(client, mt)

    res = client.messages.create(
        model="claude-sonnet-4-5",
        system="be terse",
        messages=[{"role": "user", "content": "2+2?"}],
        max_tokens=64,
        temperature=0.2,
        metadata={"user_id": "u1"},  # not in the allowlist — must be dropped
    )
    assert res is message
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "anthropic.messages"
    assert create["body"]["model"] == "claude-sonnet-4-5"
    assert create["body"]["provider"] == "anthropic"
    assert create["body"]["input"] == {"system": "be terse", "messages": [{"role": "user", "content": "2+2?"}]}
    assert create["body"]["modelParameters"] == {"max_tokens": 64, "temperature": 0.2}
    assert update["body"]["output"] == [{"type": "text", "text": "4"}]
    assert update["body"]["usage"] == {
        "promptTokens": 10,
        "completionTokens": 3,
        "totalTokens": 13,
        "cacheReadTokens": 7,
        "cacheCreationTokens": 2,
    }


def test_input_without_system_is_messages(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_anthropic(lambda **kw: _message())
    wrap_anthropic(client, mt)

    client.messages.create(model="claude-haiku-4-5", messages=[{"role": "user", "content": "hi"}], max_tokens=8)
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["input"] == [{"role": "user", "content": "hi"}]


def test_missing_usage_attrs_default(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    usage = SimpleNamespace(input_tokens=5, output_tokens=1)  # no cache token attrs
    client = _fake_anthropic(lambda **kw: SimpleNamespace(content=[{"type": "text", "text": "x"}], usage=usage))
    wrap_anthropic(client, mt)

    client.messages.create(model="claude-haiku-4-5", messages=[], max_tokens=8)
    mt.flush()
    assert _find(capture.batch(), "generation-update")["body"]["usage"] == {
        "promptTokens": 5,
        "completionTokens": 1,
        "totalTokens": 6,
        "cacheReadTokens": None,
        "cacheCreationTokens": None,
    }


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_anthropic(lambda **kw: _message())
    wrap_anthropic(client, mt, trace=trace)

    client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8)
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["traceId"] == trace.id


def test_error_marks_generation_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("overloaded")

    client = _fake_anthropic(boom)
    wrap_anthropic(client, mt)

    with pytest.raises(RuntimeError, match="overloaded"):
        client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8)
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "overloaded" in update["body"]["statusMessage"]


def test_stream_passes_through_without_recording(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    stream = iter(["chunk1", "chunk2"])
    client = _fake_anthropic(lambda **kw: stream)
    wrap_anthropic(client, mt)

    res = client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8, stream=True)
    assert res is stream
    mt.flush()
    assert capture.requests == []  # nothing buffered, nothing sent
