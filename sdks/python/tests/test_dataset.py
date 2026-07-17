"""Dataset helpers: URLs, methods, auth, request bodies, and response passthrough."""
from __future__ import annotations

from conftest import Capture

from memoturn import add_dataset_items, create_dataset, evaluate_gate, get_dataset, record_run

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y")


def test_create_dataset(capture: Capture) -> None:
    capture.responder = lambda _req: {"id": "ds-1", "name": "qa"}
    out = create_dataset("qa", "regression set", **CREDS)

    assert capture.last.get_method() == "POST"
    assert capture.last.full_url == "http://api.test/v1/datasets"
    assert capture.basic_auth() == "pk-mt-x:sk-mt-y"
    assert capture.headers()["content-type"] == "application/json"
    assert capture.body() == {"name": "qa", "description": "regression set"}
    assert out == {"id": "ds-1", "name": "qa"}


def test_add_dataset_items(capture: Capture) -> None:
    capture.responder = lambda _req: {"created": 2}
    items = [{"input": "q1", "expectedOutput": "a1"}, {"input": "q2", "metadata": {"k": 1}}]
    out = add_dataset_items("qa", items, **CREDS)

    assert capture.last.get_method() == "POST"
    assert capture.last.full_url == "http://api.test/v1/datasets/qa/items"
    assert capture.body() == {"items": items}
    assert out == {"created": 2}


def test_get_dataset(capture: Capture) -> None:
    payload = {"id": "ds-1", "name": "qa", "items": []}
    capture.responder = lambda _req: payload
    out = get_dataset("qa", **CREDS)

    assert capture.last.get_method() == "GET"
    assert capture.last.full_url == "http://api.test/v1/datasets/qa"
    assert capture.last.data is None
    assert capture.basic_auth() == "pk-mt-x:sk-mt-y"
    assert out == payload


def test_record_run_without_version(capture: Capture) -> None:
    capture.responder = lambda _req: {"runName": "run-1"}
    links = [{"datasetItemId": "it-1", "traceId": "tr-1"}]
    out = record_run("qa", "run-1", links, **CREDS)

    assert capture.last.get_method() == "POST"
    assert capture.last.full_url == "http://api.test/v1/datasets/qa/runs"
    assert capture.body() == {"runName": "run-1", "links": links}  # no "version" key
    assert out == {"runName": "run-1"}


def test_record_run_with_version(capture: Capture) -> None:
    capture.responder = lambda _req: {"runName": "run-2"}
    record_run("qa", "run-2", [], version=3, **CREDS)
    assert capture.body() == {"runName": "run-2", "links": [], "version": 3}


def test_evaluate_gate(capture: Capture) -> None:
    result = {"passed": False, "failures": ["faithfulness"], "scores": []}
    capture.responder = lambda _req: result
    thresholds = {"faithfulness": {"min": 0.8}, "toxicity": {"max": 0.1}}
    out = evaluate_gate("qa", "run-1", thresholds, baseline_run="run-0", **CREDS)

    assert capture.last.get_method() == "POST"
    assert capture.last.full_url == "http://api.test/v1/datasets/qa/runs/run-1/gate"
    assert capture.basic_auth() == "pk-mt-x:sk-mt-y"
    assert capture.body() == {"thresholds": thresholds, "baselineRun": "run-0"}
    assert out == result


def test_evaluate_gate_without_baseline(capture: Capture) -> None:
    capture.responder = lambda _req: {"passed": True, "failures": [], "scores": []}
    evaluate_gate("qa", "run-1", {"faithfulness": {"min": 0.5}}, **CREDS)
    assert capture.body() == {"thresholds": {"faithfulness": {"min": 0.5}}}  # no "baselineRun" key
