"""memoturn Python SDK — LLM observability, prompts, and evals."""
from .client import Memoturn, Span, Trace
from .dataset import add_dataset_items, create_dataset, evaluate_gate, get_dataset, record_run
from .decorator import configure, get_client, observe
from .openai import wrap_openai
from .prompt import compile_prompt, get_prompt

__all__ = [
    "Memoturn",
    "Trace",
    "Span",
    "observe",
    "configure",
    "get_client",
    "get_prompt",
    "compile_prompt",
    "wrap_openai",
    "create_dataset",
    "add_dataset_items",
    "get_dataset",
    "record_run",
    "evaluate_gate",
]

__version__ = "0.2.0"
