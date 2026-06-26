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
