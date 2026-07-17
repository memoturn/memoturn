"""Datasets, experiment runs, and CI quality gates.

Stdlib-only (urllib). Create datasets and items, link experiment runs to the traces
they produced, and gate a run's evaluator scores against thresholds in CI.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

from .client import _truncate

#: Default per-request timeout in seconds.
DEFAULT_TIMEOUT = 10.0


def _creds(base_url: Optional[str], public_key: Optional[str], secret_key: Optional[str]) -> tuple[str, str]:
    base = (base_url or os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")).rstrip("/")
    pk = public_key or os.environ.get("MEMOTURN_PUBLIC_KEY", "")
    sk = secret_key or os.environ.get("MEMOTURN_SECRET_KEY", "")
    auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    return base, auth


def _request(method: str, url: str, auth: str, body: Optional[dict[str, Any]] = None,
             timeout: float = DEFAULT_TIMEOUT) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"authorization": f"Basic {auth}"}
    if data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url} failed: {e.code} {_truncate(e.read().decode(errors='replace'))}") from e


def create_dataset(name: str, description: str = "", *, base_url: Optional[str] = None,
                   public_key: Optional[str] = None, secret_key: Optional[str] = None) -> dict[str, Any]:
    base, auth = _creds(base_url, public_key, secret_key)
    return _request("POST", f"{base}/v1/datasets", auth, {"name": name, "description": description})


def add_dataset_items(name: str, items: list[dict[str, Any]], *, base_url: Optional[str] = None,
                      public_key: Optional[str] = None, secret_key: Optional[str] = None) -> dict[str, Any]:
    """Each item: {"input": ..., "expectedOutput"?: ..., "metadata"?: {...}}."""
    base, auth = _creds(base_url, public_key, secret_key)
    return _request("POST", f"{base}/v1/datasets/{name}/items", auth, {"items": items})


def get_dataset(name: str, *, base_url: Optional[str] = None,
                public_key: Optional[str] = None, secret_key: Optional[str] = None) -> dict[str, Any]:
    base, auth = _creds(base_url, public_key, secret_key)
    return _request("GET", f"{base}/v1/datasets/{name}", auth)


def record_run(name: str, run_name: str, links: list[dict[str, str]], *, version: Optional[int] = None,
               base_url: Optional[str] = None, public_key: Optional[str] = None,
               secret_key: Optional[str] = None) -> dict[str, Any]:
    """Link dataset items to the traces produced for them. Each link: {"datasetItemId", "traceId"}."""
    base, auth = _creds(base_url, public_key, secret_key)
    body: dict[str, Any] = {"runName": run_name, "links": links}
    if version is not None:
        body["version"] = version
    return _request("POST", f"{base}/v1/datasets/{name}/runs", auth, body)


def evaluate_gate(name: str, run_name: str, thresholds: dict[str, dict[str, float]], *,
                  baseline_run: Optional[str] = None, base_url: Optional[str] = None,
                  public_key: Optional[str] = None, secret_key: Optional[str] = None) -> dict[str, Any]:
    """Gate a run's scores against thresholds for CI.

    thresholds: {"faithfulness": {"min": 0.8}, "toxicity": {"max": 0.1}} — each bound may set
    "min", "max", and/or "maxRegression" (the last requires baseline_run). Returns the gate
    result dict {"passed": bool, "failures": [...], "scores": [...]}; check ["passed"] for CI.
    """
    base, auth = _creds(base_url, public_key, secret_key)
    body: dict[str, Any] = {"thresholds": thresholds}
    if baseline_run is not None:
        body["baselineRun"] = baseline_run
    return _request("POST", f"{base}/v1/datasets/{name}/runs/{run_name}/gate", auth, body)
