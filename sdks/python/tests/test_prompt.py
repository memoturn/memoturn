"""Prompt fetch (GET + auth) and {{var}} compilation for TEXT and CHAT prompts."""
from __future__ import annotations

from conftest import Capture

from memoturn import compile_prompt, get_prompt

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y")


def test_get_prompt_url_and_auth(capture: Capture) -> None:
    payload = {"name": "greet", "version": 3, "type": "TEXT", "content": "hi", "config": {}}
    capture.responder = lambda _req: payload
    out = get_prompt("greet", **CREDS)

    assert capture.last.get_method() == "GET"
    assert capture.last.full_url == "http://api.test/v1/prompts/greet?channel=production"
    assert capture.basic_auth() == "pk-mt-x:sk-mt-y"
    assert out == payload


def test_get_prompt_custom_channel(capture: Capture) -> None:
    capture.responder = lambda _req: {"name": "p", "version": 1, "type": "TEXT", "content": "", "config": {}}
    get_prompt("p", channel="staging", **CREDS)
    assert capture.last.full_url == "http://api.test/v1/prompts/p?channel=staging"


def test_compile_text_leaves_unknown_vars() -> None:
    prompt = {"type": "TEXT", "content": "Hi {{name}}, {{missing}}"}
    assert compile_prompt(prompt, name="Ada") == "Hi Ada, {{missing}}"


def test_compile_chat_fills_each_message() -> None:
    prompt = {
        "type": "CHAT",
        "content": [
            {"role": "system", "content": "You are {{persona}}."},
            {"role": "user", "content": "Count to {{n}}."},
        ],
    }
    assert compile_prompt(prompt, persona="terse", n=3) == [
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "Count to 3."},
    ]


def test_compile_coerces_and_trims_whitespace() -> None:
    assert compile_prompt({"type": "TEXT", "content": "n={{ count }}"}, count=42) == "n=42"
