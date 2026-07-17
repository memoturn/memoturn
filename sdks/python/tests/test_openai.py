"""wrap_openai records each chat completion as a generation with mapped usage."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_openai

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_openai(create):
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def _completion():
    message = SimpleNamespace(model_dump=lambda: {"role": "assistant", "content": "4"})
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=1, total_tokens=11)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


def _fake_with_responses(create):
    chat = SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: _completion()))
    return SimpleNamespace(chat=chat, responses=SimpleNamespace(create=create))


def _response():
    usage = SimpleNamespace(input_tokens=12, output_tokens=7, total_tokens=19)
    return SimpleNamespace(output_text="it works", output=[{"type": "message"}], usage=usage)


def test_records_generation_with_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    completion = _completion()
    client = _fake_openai(lambda **kw: completion)
    wrap_openai(client, mt)

    res = client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "2+2?"}], temperature=0.2)
    assert res is completion
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["model"] == "gpt-4o"
    assert create["body"]["provider"] == "openai"
    assert create["body"]["modelParameters"] == {"temperature": 0.2}
    assert create["body"]["input"] == [{"role": "user", "content": "2+2?"}]
    assert update["body"]["output"] == {"role": "assistant", "content": "4"}
    assert update["body"]["usage"] == {"promptTokens": 10, "completionTokens": 1, "totalTokens": 11}


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_openai(lambda **kw: _completion())
    wrap_openai(client, mt, trace=trace)

    client.chat.completions.create(model="gpt-4o", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["traceId"] == trace.id


def test_error_marks_generation_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("rate limited")

    client = _fake_openai(boom)
    wrap_openai(client, mt)

    with pytest.raises(RuntimeError, match="rate limited"):
        client.chat.completions.create(model="gpt-4o", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "rate limited" in update["body"]["statusMessage"]


def test_records_generation_for_responses(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = _response()
    client = _fake_with_responses(lambda **kw: resp)
    wrap_openai(client, mt)

    res = client.responses.create(model="gpt-4o", input="hi", instructions="be terse", top_p=0.9)
    assert res is resp
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "openai.responses"
    assert create["body"]["model"] == "gpt-4o"
    assert create["body"]["modelParameters"] == {"top_p": 0.9}
    assert create["body"]["input"] == {"instructions": "be terse", "input": "hi"}
    assert update["body"]["output"] == "it works"
    assert update["body"]["usage"] == {"promptTokens": 12, "completionTokens": 7, "totalTokens": 19}


def test_responses_output_items_fallback(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    out = [{"type": "function_call", "name": "get_weather", "arguments": "{}"}]
    client = _fake_with_responses(lambda **kw: SimpleNamespace(output=out))  # no output_text / usage
    wrap_openai(client, mt)

    client.responses.create(model="gpt-4o", input="weather?")
    mt.flush()
    assert _find(capture.batch(), "generation-update")["body"]["output"] == out


def test_wrap_without_responses_is_noop(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_openai(lambda **kw: _completion())  # no `responses` attr
    wrap_openai(client, mt)  # must not raise

    client.chat.completions.create(model="gpt-4o", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["name"] == "openai.chat.completions"


# ── streaming (chat.completions) ─────────────────────────────────────────────────


def _delta(**kw: object) -> SimpleNamespace:
    return SimpleNamespace(**kw)


def _choice(index: int = 0, **kw: object) -> SimpleNamespace:
    return SimpleNamespace(index=index, delta=_delta(**kw))


def _stream_chunk(choices: list | None = None, usage: object | None = None) -> SimpleNamespace:
    return SimpleNamespace(choices=choices or [], usage=usage)


def _tool_call_delta(index: int, **kw: object) -> SimpleNamespace:
    func = SimpleNamespace(name=kw.pop("name", None), arguments=kw.pop("arguments", None))
    return SimpleNamespace(index=index, id=kw.pop("id_", None), type=kw.pop("type_", None), function=func)


def _fake_stream_openai(chunks: list) -> SimpleNamespace:
    return _fake_openai(lambda **kw: iter(chunks))


def test_stream_forwards_chunks_unchanged_and_excludes_stream_kwargs_from_params(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [
        _stream_chunk([_choice(role="assistant", content="")]),
        _stream_chunk([_choice(content="Hel")]),
        _stream_chunk([_choice(content="lo")]),
        _stream_chunk(usage=SimpleNamespace(prompt_tokens=5, completion_tokens=2, total_tokens=7)),
    ]
    client = _fake_stream_openai(chunks)
    wrap_openai(client, mt)

    stream = client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "hi"}], stream=True)
    assert list(stream) == chunks  # forwarded unchanged
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["modelParameters"] == {}  # model/messages/stream/stream_options excluded
    assert update["body"]["output"] == {"role": "assistant", "content": "Hello"}
    assert update["body"]["usage"] == {"promptTokens": 5, "completionTokens": 2, "totalTokens": 7}


def test_stream_accumulates_tool_calls(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [
        _stream_chunk(
            [_choice(role="assistant", tool_calls=[_tool_call_delta(0, id_="call_1", type_="function", name="get_weather", arguments="")])]
        ),
        _stream_chunk([_choice(tool_calls=[_tool_call_delta(0, arguments='{"c')])]),
        _stream_chunk([_choice(tool_calls=[_tool_call_delta(0, arguments='ity":"SF"}')])]),
    ]
    client = _fake_stream_openai(chunks)
    wrap_openai(client, mt)

    list(client.chat.completions.create(model="gpt-4o", messages=[], stream=True))
    mt.flush()

    output = _find(capture.batch(), "generation-update")["body"]["output"]
    assert output["role"] == "assistant"
    assert output["tool_calls"] == [
        {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"SF"}'}}
    ]


def test_stream_options_auto_injected_but_explicit_value_is_respected(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    seen: dict = {}

    def create(**kw: object) -> object:
        seen.update(kw)
        return iter([_stream_chunk(usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2))])

    client = _fake_openai(create)
    wrap_openai(client, mt)

    list(client.chat.completions.create(model="gpt-4o", messages=[], stream=True))
    assert seen["stream_options"] == {"include_usage": True}

    seen.clear()
    list(
        client.chat.completions.create(
            model="gpt-4o", messages=[], stream=True, stream_options={"include_usage": False}
        )
    )
    assert seen["stream_options"] == {"include_usage": False}


def test_stream_mid_error_marks_generation_error_with_partial_output_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def create(**kw: object) -> object:
        def gen():
            yield _stream_chunk([_choice(role="assistant", content="partial")])
            raise RuntimeError("stream broke")

        return gen()

    client = _fake_openai(create)
    wrap_openai(client, mt)

    stream = client.chat.completions.create(model="gpt-4o", messages=[], stream=True)
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
    client = _fake_stream_openai(chunks)
    wrap_openai(client, mt)

    stream = client.chat.completions.create(model="gpt-4o", messages=[], stream=True)
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

    client = _fake_openai(boom)
    wrap_openai(client, mt)

    with pytest.raises(RuntimeError, match="connection refused"):
        client.chat.completions.create(model="gpt-4o", messages=[], stream=True)
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "connection refused" in update["body"]["statusMessage"]


# ── streaming (responses API) ────────────────────────────────────────────────────


def _resp_event(type_: str, response: object | None = None) -> SimpleNamespace:
    return SimpleNamespace(type=type_, response=response)


def test_responses_stream_completed_records_output_and_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = SimpleNamespace(
        output_text="done", usage=SimpleNamespace(input_tokens=3, output_tokens=4, total_tokens=7)
    )
    chunks = [_resp_event("response.in_progress"), _resp_event("response.completed", response=resp)]
    client = _fake_with_responses(lambda **kw: iter(chunks))
    wrap_openai(client, mt)

    stream = client.responses.create(model="gpt-4o", input="hi", stream=True)
    assert list(stream) == chunks
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["modelParameters"] == {}
    assert update["body"]["output"] == "done"
    assert update["body"]["usage"] == {"promptTokens": 3, "completionTokens": 4, "totalTokens": 7}


def test_responses_stream_failed_marks_generation_error(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = SimpleNamespace(output_text="partial", usage=None)
    chunks = [_resp_event("response.failed", response=resp)]
    client = _fake_with_responses(lambda **kw: iter(chunks))
    wrap_openai(client, mt)

    list(client.responses.create(model="gpt-4o", input="hi", stream=True))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert update["body"]["statusMessage"] == "response.failed"
    assert update["body"]["output"] == "partial"


def test_responses_stream_without_terminal_event_marks_generation_error(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [_resp_event("response.in_progress")]
    client = _fake_with_responses(lambda **kw: iter(chunks))
    wrap_openai(client, mt)

    list(client.responses.create(model="gpt-4o", input="hi", stream=True))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "terminal" in update["body"]["statusMessage"]


def test_responses_stream_early_close_marks_generation_warning(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = SimpleNamespace(output_text="partial", usage=None)
    chunks = [_resp_event("response.output_text.delta"), _resp_event("response.completed", response=resp)]
    client = _fake_with_responses(lambda **kw: iter(chunks))
    wrap_openai(client, mt)

    stream = client.responses.create(model="gpt-4o", input="hi", stream=True)
    next(stream)
    stream.close()
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "WARNING"
    assert update["body"]["statusMessage"] == "stream ended before completion"
