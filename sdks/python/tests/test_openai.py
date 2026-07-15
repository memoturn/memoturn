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
