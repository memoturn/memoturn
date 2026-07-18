"""wrap_groq records chat.completions.create as a generation. Groq's create() has a
strict, fully-enumerated signature with no stream_options field and no catch-all
kwargs, so — unlike wrap_openai — this wrapper must never inject stream_options; the
dedicated regression test below locks that in."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_groq

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_groq(create, **extra):
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), **extra)


def _completion():
    message = SimpleNamespace(model_dump=lambda: {"role": "assistant", "content": "4"})
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=1, total_tokens=11)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


def test_records_generation_with_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    completion = _completion()
    client = _fake_groq(lambda **kw: completion)
    wrap_groq(client, mt)

    res = client.chat.completions.create(
        model="llama-3.3-70b-versatile", messages=[{"role": "user", "content": "2+2?"}], top_p=0.9
    )
    assert res is completion
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "groq.chat"
    assert create["body"]["model"] == "llama-3.3-70b-versatile"
    assert create["body"]["provider"] == "groq"
    # exclusion-list modelParameters: only model/messages/stream are excluded — an
    # arbitrary extra param (top_p) DOES appear, unlike Bedrock's small allowlist.
    assert create["body"]["modelParameters"] == {"top_p": 0.9}
    assert create["body"]["input"] == [{"role": "user", "content": "2+2?"}]
    assert update["body"]["output"] == {"role": "assistant", "content": "4"}
    assert update["body"]["usage"] == {"promptTokens": 10, "completionTokens": 1, "totalTokens": 11}


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_groq(lambda **kw: _completion())
    wrap_groq(client, mt, trace=trace)

    client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["traceId"] == trace.id


def test_uses_default_trace_when_none_provided(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_groq(lambda **kw: _completion())
    wrap_groq(client, mt)

    client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[])
    mt.flush()
    create = _find(capture.batch(), "generation-create")
    assert create["body"]["traceId"]  # a fresh trace was created


def test_error_marks_generation_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("rate limited")

    client = _fake_groq(boom)
    wrap_groq(client, mt)

    with pytest.raises(RuntimeError, match="rate limited"):
        client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "rate limited" in update["body"]["statusMessage"]


def test_other_client_attributes_pass_through_untouched(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    sentinel = object()
    client = _fake_groq(lambda **kw: _completion(), models=SimpleNamespace(list=lambda: sentinel))
    wrap_groq(client, mt)  # must not touch client.models

    assert client.models.list() is sentinel


# ── streaming ────────────────────────────────────────────────────────────────────


def _delta(**kw: object) -> SimpleNamespace:
    return SimpleNamespace(**kw)


def _choice(index: int = 0, **kw: object) -> SimpleNamespace:
    return SimpleNamespace(index=index, delta=_delta(**kw))


def _stream_chunk(choices: list | None = None, usage: object | None = None) -> SimpleNamespace:
    return SimpleNamespace(choices=choices or [], usage=usage)


def _tool_call_delta(index: int, **kw: object) -> SimpleNamespace:
    func = SimpleNamespace(name=kw.pop("name", None), arguments=kw.pop("arguments", None))
    return SimpleNamespace(index=index, id=kw.pop("id_", None), type=kw.pop("type_", None), function=func)


def _fake_stream_groq(chunks: list) -> SimpleNamespace:
    return _fake_groq(lambda **kw: iter(chunks))


def test_stream_forwards_chunks_unchanged_and_concatenates_content(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [
        _stream_chunk([_choice(role="assistant", content="")]),
        _stream_chunk([_choice(content="Hel")]),
        _stream_chunk([_choice(content="lo")]),
    ]
    client = _fake_stream_groq(chunks)
    wrap_groq(client, mt)

    stream = client.chat.completions.create(
        model="llama-3.3-70b-versatile", messages=[{"role": "user", "content": "hi"}], stream=True
    )
    assert list(stream) == chunks  # forwarded unchanged
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["modelParameters"] == {}  # model/messages/stream excluded
    assert update["body"]["output"] == {"role": "assistant", "content": "Hello"}


def test_stream_accumulates_tool_calls_by_index(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [
        _stream_chunk(
            [_choice(role="assistant", tool_calls=[_tool_call_delta(0, id_="call_1", type_="function", name="get_weather", arguments="")])]
        ),
        _stream_chunk([_choice(tool_calls=[_tool_call_delta(0, arguments='{"c')])]),
        _stream_chunk([_choice(tool_calls=[_tool_call_delta(0, arguments='ity":"SF"}')])]),
    ]
    client = _fake_stream_groq(chunks)
    wrap_groq(client, mt)

    list(client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[], stream=True))
    mt.flush()

    output = _find(capture.batch(), "generation-update")["body"]["output"]
    assert output["role"] == "assistant"
    # tool_calls is keyed by tool-call index (JSON round-trips int keys to strings).
    assert output["tool_calls"] == {
        "0": {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"SF"}'}}
    }


def test_stream_usage_captured_if_a_chunk_carries_it(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [
        _stream_chunk([_choice(role="assistant", content="hi")]),
        _stream_chunk(usage=SimpleNamespace(prompt_tokens=5, completion_tokens=2, total_tokens=7)),
    ]
    client = _fake_stream_groq(chunks)
    wrap_groq(client, mt)

    list(client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[], stream=True))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["usage"] == {"promptTokens": 5, "completionTokens": 2, "totalTokens": 7}


def test_stream_usage_absent_is_fine_no_crash(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [_stream_chunk([_choice(role="assistant", content="hi")])]  # no chunk carries usage
    client = _fake_stream_groq(chunks)
    wrap_groq(client, mt)

    list(client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[], stream=True))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"].get("usage") is None


def test_stream_mid_error_marks_generation_error_with_partial_output_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def create(**kw: object) -> object:
        def gen():
            yield _stream_chunk([_choice(role="assistant", content="partial")])
            raise RuntimeError("stream broke")

        return gen()

    client = _fake_groq(create)
    wrap_groq(client, mt)

    stream = client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[], stream=True)
    with pytest.raises(RuntimeError, match="stream broke"):
        list(stream)
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "stream broke" in update["body"]["statusMessage"]
    assert update["body"]["output"] == {"role": "assistant", "content": "partial"}


def test_stream_early_close_marks_generation_warning_with_partial_output(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [
        _stream_chunk([_choice(role="assistant", content="partial")]),
        _stream_chunk([_choice(content="more")]),
    ]
    client = _fake_stream_groq(chunks)
    wrap_groq(client, mt)

    stream = client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[], stream=True)
    next(stream)
    stream.close()
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "WARNING"
    assert update["body"]["statusMessage"] == "stream ended before completion"
    assert update["body"]["output"] == {"role": "assistant", "content": "partial"}


def test_synchronous_stream_start_failure_marks_error_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw: object) -> object:
        raise RuntimeError("connection refused")

    client = _fake_groq(boom)
    wrap_groq(client, mt)

    with pytest.raises(RuntimeError, match="connection refused"):
        client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[], stream=True)
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "connection refused" in update["body"]["statusMessage"]


def test_stream_options_is_never_injected(capture: Capture) -> None:
    """Regression test: this is the entire reason wrap_groq exists instead of pointing
    wrap_openai at a Groq client. Groq's real create() has no stream_options parameter
    and no catch-all **kwargs — injecting it (as wrap_openai does) would raise
    TypeError on every streaming call against a real Groq client."""
    mt = Memoturn(**CREDS)
    seen: dict = {}

    def create(**kw: object) -> object:
        seen.update(kw)
        return iter([_stream_chunk([_choice(role="assistant", content="hi")])])

    client = _fake_groq(create)
    wrap_groq(client, mt)

    list(client.chat.completions.create(model="llama-3.3-70b-versatile", messages=[], stream=True))
    assert "stream_options" not in seen
