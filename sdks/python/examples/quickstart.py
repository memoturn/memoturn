"""Emit a trace from Python end-to-end. Run after `bun run dev` + `bun run seed`:

    cd sdks/python && uv run examples/quickstart.py
"""
import os
import time

from memoturn import Memoturn, configure, observe

configure(
    Memoturn(
        base_url=os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001"),
        public_key=os.environ.get("MEMOTURN_PUBLIC_KEY", "pk-mt-dev"),
        secret_key=os.environ.get("MEMOTURN_SECRET_KEY", "sk-mt-dev"),
    )
)


@observe()
def retrieve(query: str) -> list[str]:
    time.sleep(0.02)
    return ["memoturn is an open-source AI engineering platform."]


@observe(as_type="generation")
def answer(question: str, docs: list[str]) -> str:
    time.sleep(0.05)
    return "memoturn is an open-source AI engineering platform."


@observe(name="rag-pipeline")
def rag(question: str) -> str:
    docs = retrieve(question)
    return answer(question, docs)


if __name__ == "__main__":
    from memoturn import get_client

    result = rag("What is memoturn?")
    get_client().shutdown()  # flush
    print("answer:", result)
    print("emitted a nested trace (rag-pipeline → retrieve, answer)")
    print("  open the console Traces view to see the waterfall")
