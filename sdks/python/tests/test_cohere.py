"""wrap_cohere records chat / chat_stream as generations, handling both the v2 API
(message.content list + usage.tokens) and the legacy v1 API (text + meta.tokens,
event_type-discriminated stream events) in one wrapper."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_cohere

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_cohere(chat, chat_stream=None, **extra):
    ns = SimpleNamespace(chat=chat, **extra)
    if chat_stream is not None:
        ns.chat_stream = chat_stream
    return ns


def _v2_response():
    message = SimpleNamespace(
        model_dump=lambda: {"role": "assistant", "content": [{"type": "text", "text": "4"}]},
    )
    usage = SimpleNamespace(
        tokens=SimpleNamespace(input_tokens=10.0, output_tokens=2.0),
        billed_units=SimpleNamespace(input_tokens=9.0, output_tokens=2.0),
    )
    return SimpleNamespace(message=message, usage=usage, text=None, meta=None)


def _v1_response():
    meta = SimpleNamespace(
        tokens=SimpleNamespace(input_tokens=7.0, output_tokens=3.0),
        billed_units=SimpleNamespace(input_tokens=6.0, output_tokens=3.0),
    )
    return SimpleNamespace(text="4", meta=meta, message=None, usage=None)


# ── non-streaming ────────────────────────────────────────────────────────────────


def test_v2_chat_records_generation_with_int_coerced_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    response = _v2_response()
    client = _fake_cohere(lambda **kw: response)
    wrap_cohere(client, mt)

    res = client.chat(model="command-r-plus", messages=[{"role": "user", "content": "2+2?"}], temperature=0.3)
    assert res is response
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "cohere.chat"
    assert create["body"]["model"] == "command-r-plus"
    assert create["body"]["provider"] == "cohere"
    assert create["body"]["input"] == [{"role": "user", "content": "2+2?"}]
    assert create["body"]["modelParameters"] == {"temperature": 0.3}
    assert update["body"]["output"] == {"role": "assistant", "content": [{"type": "text", "text": "4"}]}
    # floats int-coerced; total computed (Cohere never reports one).
    assert update["body"]["usage"] == {"promptTokens": 10, "completionTokens": 2, "totalTokens": 12}


def test_v2_chat_without_model_dump_extracts_text_content(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    message = SimpleNamespace(
        role="assistant",
        content=[SimpleNamespace(type="text", text="hel"), SimpleNamespace(type="text", text="lo")],
    )
    response = SimpleNamespace(message=message, usage=None, meta=None)
    client = _fake_cohere(lambda **kw: response)
    wrap_cohere(client, mt)

    client.chat(model="command-r-plus", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["output"] == {"role": "assistant", "content": "hello"}
    assert update["body"].get("usage") is None


def test_v1_chat_records_text_and_meta_tokens(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_cohere(lambda **kw: _v1_response())
    wrap_cohere(client, mt)

    client.chat(model="command-r", message="2+2?", chat_history=[{"role": "USER", "message": "hi"}])
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["input"] == {"chatHistory": [{"role": "USER", "message": "hi"}], "message": "2+2?"}
    assert create["body"]["modelParameters"] == {}
    assert update["body"]["output"] == {"role": "assistant", "content": "4"}
    assert update["body"]["usage"] == {"promptTokens": 7, "completionTokens": 3, "totalTokens": 10}


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_cohere(lambda **kw: _v2_response())
    wrap_cohere(client, mt, trace=trace)

    client.chat(model="command-r-plus", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["traceId"] == trace.id


def test_error_marks_generation_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("rate limited")

    client = _fake_cohere(boom)
    wrap_cohere(client, mt)

    with pytest.raises(RuntimeError, match="rate limited"):
        client.chat(model="command-r-plus", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "rate limited" in update["body"]["statusMessage"]


# ── streaming ────────────────────────────────────────────────────────────────────


def _v2_delta(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content-delta",
        delta=SimpleNamespace(message=SimpleNamespace(content=SimpleNamespace(text=text))),
    )


def _v2_end(input_tokens: float, output_tokens: float) -> SimpleNamespace:
    usage = SimpleNamespace(tokens=SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens))
    return SimpleNamespace(type="message-end", delta=SimpleNamespace(usage=usage))


def test_v2_stream_accumulates_deltas_and_final_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        SimpleNamespace(type="message-start"),
        _v2_delta("Hel"),
        _v2_delta("lo"),
        _v2_end(5.0, 2.0),
    ]
    client = _fake_cohere(lambda **kw: None, chat_stream=lambda **kw: iter(events))
    wrap_cohere(client, mt)

    stream = client.chat_stream(model="command-r-plus", messages=[{"role": "user", "content": "hi"}])
    assert list(stream) == events  # forwarded unchanged
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["output"] == {"role": "assistant", "content": "Hello"}
    assert update["body"]["usage"] == {"promptTokens": 5, "completionTokens": 2, "totalTokens": 7}


def test_v1_stream_accumulates_text_generation_and_stream_end_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        SimpleNamespace(event_type="stream-start"),
        SimpleNamespace(event_type="text-generation", text="Hel"),
        SimpleNamespace(event_type="text-generation", text="lo"),
        SimpleNamespace(event_type="stream-end", response=_v1_response()),
    ]
    client = _fake_cohere(lambda **kw: None, chat_stream=lambda **kw: iter(events))
    wrap_cohere(client, mt)

    list(client.chat_stream(model="command-r", message="hi"))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["output"] == {"role": "assistant", "content": "Hello"}
    assert update["body"]["usage"] == {"promptTokens": 7, "completionTokens": 3, "totalTokens": 10}


def test_stream_mid_error_marks_generation_error_with_partial_output_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def chat_stream(**kw: object) -> object:
        def gen():
            yield _v2_delta("partial")
            raise RuntimeError("stream broke")

        return gen()

    client = _fake_cohere(lambda **kw: None, chat_stream=chat_stream)
    wrap_cohere(client, mt)

    with pytest.raises(RuntimeError, match="stream broke"):
        list(client.chat_stream(model="command-r-plus", messages=[]))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "stream broke" in update["body"]["statusMessage"]
    assert update["body"]["output"] == {"role": "assistant", "content": "partial"}


def test_stream_early_close_marks_generation_warning(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [_v2_delta("partial"), _v2_delta("more"), _v2_end(1.0, 1.0)]
    client = _fake_cohere(lambda **kw: None, chat_stream=lambda **kw: iter(events))
    wrap_cohere(client, mt)

    stream = client.chat_stream(model="command-r-plus", messages=[])
    next(stream)
    stream.close()
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "WARNING"
    assert update["body"]["output"] == {"role": "assistant", "content": "partial"}


def test_synchronous_stream_start_failure_marks_error_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw: object) -> object:
        raise RuntimeError("connection refused")

    client = _fake_cohere(lambda **kw: None, chat_stream=boom)
    wrap_cohere(client, mt)

    with pytest.raises(RuntimeError, match="connection refused"):
        client.chat_stream(model="command-r-plus", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "connection refused" in update["body"]["statusMessage"]


def test_client_without_chat_stream_still_wraps_chat(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_cohere(lambda **kw: _v2_response())
    assert not hasattr(client, "chat_stream")
    wrap_cohere(client, mt)  # must not crash on a client with no chat_stream

    client.chat(model="command-r-plus", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["name"] == "cohere.chat"
