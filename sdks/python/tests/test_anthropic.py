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


# ── streaming ─────────────────────────────────────────────────────────────────────


def _fake_stream_anthropic(events: list) -> SimpleNamespace:
    return _fake_anthropic(lambda **kw: iter(events))


def _event(type_: str, **kw: object) -> SimpleNamespace:
    return SimpleNamespace(type=type_, **kw)


def test_stream_accumulates_text_deltas_and_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event(
            "message_start",
            message=SimpleNamespace(
                usage=SimpleNamespace(input_tokens=10, cache_read_input_tokens=7, cache_creation_input_tokens=2)
            ),
        ),
        _event("content_block_start", index=0, content_block=SimpleNamespace(type="text", text="")),
        _event("content_block_delta", index=0, delta=SimpleNamespace(type="text_delta", text="Hel")),
        _event("content_block_delta", index=0, delta=SimpleNamespace(type="text_delta", text="lo")),
        _event("content_block_stop", index=0),
        _event("message_delta", usage=SimpleNamespace(output_tokens=3)),
        _event("message_stop"),
    ]
    client = _fake_stream_anthropic(events)
    wrap_anthropic(client, mt)

    stream = client.messages.create(
        model="claude-sonnet-4-5", messages=[{"role": "user", "content": "2+2?"}], max_tokens=64, stream=True
    )
    assert list(stream) == events  # forwarded unchanged
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["modelParameters"] == {"max_tokens": 64}
    assert update["body"]["output"] == [{"type": "text", "text": "Hello"}]
    assert update["body"]["usage"] == {
        "promptTokens": 10,
        "completionTokens": 3,
        "totalTokens": 13,
        "cacheReadTokens": 7,
        "cacheCreationTokens": 2,
    }


def test_stream_accumulates_tool_use_input_json(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event("message_start", message=SimpleNamespace(usage=SimpleNamespace(input_tokens=5))),
        _event(
            "content_block_start",
            index=0,
            content_block=SimpleNamespace(type="tool_use", id="tool_1", name="get_weather"),
        ),
        _event("content_block_delta", index=0, delta=SimpleNamespace(type="input_json_delta", partial_json='{"ci')),
        _event(
            "content_block_delta", index=0, delta=SimpleNamespace(type="input_json_delta", partial_json='ty":"SF"}')
        ),
        _event("content_block_stop", index=0),
        _event("message_delta", usage=SimpleNamespace(output_tokens=4)),
    ]
    client = _fake_stream_anthropic(events)
    wrap_anthropic(client, mt)

    list(client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8, stream=True))
    mt.flush()

    output = _find(capture.batch(), "generation-update")["body"]["output"]
    assert output == [{"type": "tool_use", "id": "tool_1", "name": "get_weather", "input": {"city": "SF"}}]


def test_stream_input_json_delta_falls_back_to_raw_string_on_parse_error(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event("content_block_start", index=0, content_block=SimpleNamespace(type="tool_use", id="t", name="f")),
        _event("content_block_delta", index=0, delta=SimpleNamespace(type="input_json_delta", partial_json="not-json")),
        _event("content_block_stop", index=0),
    ]
    client = _fake_stream_anthropic(events)
    wrap_anthropic(client, mt)

    list(client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8, stream=True))
    mt.flush()

    output = _find(capture.batch(), "generation-update")["body"]["output"]
    assert output[0]["input"] == "not-json"  # never raises out of the accumulator


def test_stream_mid_error_marks_generation_error_with_partial_output_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def create(**kw: object) -> object:
        def gen():
            yield _event("content_block_start", index=0, content_block=SimpleNamespace(type="text", text=""))
            yield _event("content_block_delta", index=0, delta=SimpleNamespace(type="text_delta", text="partial"))
            raise RuntimeError("overloaded mid-stream")

        return gen()

    client = _fake_anthropic(create)
    wrap_anthropic(client, mt)

    stream = client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8, stream=True)
    with pytest.raises(RuntimeError, match="overloaded mid-stream"):
        list(stream)
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "overloaded mid-stream" in update["body"]["statusMessage"]
    assert update["body"]["output"] == [{"type": "text", "text": "partial"}]


def test_stream_early_close_marks_generation_warning_with_partial_output(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event("content_block_start", index=0, content_block=SimpleNamespace(type="text", text="")),
        _event("content_block_delta", index=0, delta=SimpleNamespace(type="text_delta", text="partial")),
        _event("content_block_delta", index=0, delta=SimpleNamespace(type="text_delta", text="-more")),
    ]
    client = _fake_stream_anthropic(events)
    wrap_anthropic(client, mt)

    stream = client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8, stream=True)
    next(stream)
    next(stream)
    stream.close()
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "WARNING"
    assert update["body"]["statusMessage"] == "stream ended before completion"
    assert update["body"]["output"] == [{"type": "text", "text": "partial"}]


def test_synchronous_stream_start_failure_marks_error_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw: object) -> object:
        raise RuntimeError("overloaded")

    client = _fake_anthropic(boom)
    wrap_anthropic(client, mt)

    with pytest.raises(RuntimeError, match="overloaded"):
        client.messages.create(model="claude-sonnet-4-5", messages=[], max_tokens=8, stream=True)
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "overloaded" in update["body"]["statusMessage"]
