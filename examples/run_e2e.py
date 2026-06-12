"""Run every example as an e2e suite against a real node.

If a node already answers at MEMOTURN_URL (default http://127.0.0.1:8080) it
is reused; otherwise this builds memoturnd, spawns a throwaway single-node
instance (temp data dir, random port, auth off, local-FS object store) and
tears it down afterwards. Each demo is a subprocess that exits nonzero on any
failed check, including a scripted pass over memory-agent/script.txt.

Run: python3 examples/run_e2e.py   (or `make demos`)
Env passthrough: ANTHROPIC_API_KEY enables the demos' LLM layers;
MEMOTURN_EXTRACT_API_KEY etc. reach a spawned node. Auth/cluster vars are
stripped from a spawned node so it always comes up open and local.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES = os.path.join(REPO_ROOT, "examples")

DEMOS = [
    ("support-agent", os.path.join(EXAMPLES, "support-agent", "demo.py"), None),
    ("multi-agent", os.path.join(EXAMPLES, "multi-agent", "demo.py"), None),
    ("what-if", os.path.join(EXAMPLES, "what-if", "demo.py"), None),
    ("governance", os.path.join(EXAMPLES, "governance", "demo.py"), None),
    (
        "memory-agent (scripted)",
        os.path.join(EXAMPLES, "memory-agent", "agent.py"),
        os.path.join(EXAMPLES, "memory-agent", "script.txt"),
    ),
]


def healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=2) as r:
            return r.read().decode().strip() == "ok"
    except (urllib.error.URLError, OSError):
        return False


def ensure_node():
    """(url, process, data_dir) — process/data_dir are None when reusing."""
    url = os.environ.get("MEMOTURN_URL", "http://127.0.0.1:8080")
    if healthy(url):
        print(f"reusing the node at {url}")
        return url, None, None

    print(f"no node at {url} — building and spawning a throwaway one")
    subprocess.run(["cargo", "build", "-p", "memoturnd"], cwd=REPO_ROOT, check=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    data_dir = tempfile.mkdtemp(prefix="memoturn-e2e-")
    env = dict(os.environ)
    for var in (
        "MEMOTURN_AUTH",
        "MEMOTURN_PLATFORM_KEY",
        "MEMOTURN_TOKEN",
        "MEMOTURN_ETCD",
        "MEMOTURN_ADVERTISE",
        "MEMOTURN_OBJECT_STORE",
    ):
        env.pop(var, None)
    env.update(
        MEMOTURN_DATA_DIR=data_dir,
        MEMOTURN_LISTEN=f"127.0.0.1:{port}",
        MEMOTURN_SINGLE_NODE="1",
        MEMOTURN_AUDIT_FLUSH_MS="250",
    )
    proc = subprocess.Popen([os.path.join(REPO_ROOT, "target", "debug", "memoturnd")], env=env)
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 30
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"memoturnd exited early with code {proc.returncode}")
        if healthy(url):
            print(f"node up at {url} (data under {data_dir})")
            return url, proc, data_dir
        time.sleep(0.25)
    proc.kill()
    raise SystemExit("memoturnd did not become healthy within 30s")


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # keep our headers ordered with child output
    try:
        import httpx  # noqa: F401
    except ImportError:
        raise SystemExit(
            "the demos need httpx — run: pip install -r examples/requirements.txt"
        )
    if os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY set — the demos' LLM layers will run too")

    url, proc, data_dir = ensure_node()
    env = {**os.environ, "MEMOTURN_URL": url}
    # A spawned node is auth-off; stale creds in the caller's env would only
    # confuse the demos' clients.
    if proc is not None:
        env.pop("MEMOTURN_TOKEN", None)
        env.pop("MEMOTURN_PLATFORM_KEY", None)
    results = []
    try:
        for name, path, stdin_path in DEMOS:
            print(f"\n{'=' * 60}\n{name}\n{'=' * 60}")
            stdin = open(stdin_path) if stdin_path else None
            try:
                code = subprocess.run([sys.executable, path], env=env, stdin=stdin).returncode
            finally:
                if stdin:
                    stdin.close()
            results.append((name, code))
    finally:
        if proc is not None:
            proc.terminate()  # graceful: lets the node drain its audit buffer
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if data_dir is not None:
            shutil.rmtree(data_dir, ignore_errors=True)

    print(f"\n{'=' * 60}")
    for name, code in results:
        print(f"  {'PASS' if code == 0 else 'FAIL'}  {name}")
    if any(code != 0 for _, code in results):
        sys.exit(1)
    print("\nexamples e2e: ok")


if __name__ == "__main__":
    main()
