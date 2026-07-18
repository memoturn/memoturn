"""CrewAI instrumentation — registers handlers on CrewAI's process-global event bus
to record crew/task/agent/tool/LLM execution as a nested trace tree.

CrewAI has its own independent, typed event-bus system (``crewai.events.crewai_event_bus``,
a process-wide singleton) — not built on LangChain's callback system at all, even though
CrewAI often uses LangChain-compatible LLM clients under the hood. So unlike every other
integration in this SDK, this one is a **global instrumentation function**: call it once
at process startup, not per-crew or per-session:

    from memoturn.crewai import instrument_crewai
    instrument_crewai()

    # ... build and kick off Crews as usual — every crew in this process is now traced.

Requires the real ``crewai`` package (``pip install "memoturn[crewai]"``) — unlike every
duck-typed wrapper in this SDK, there is no way to observe CrewAI's event bus without
importing its typed event classes to register handlers for them. The import is deferred
to inside ``instrument_crewai()``, so ``import memoturn`` itself never touches ``crewai``.
"""
from __future__ import annotations

from typing import Any, Optional

from .client import Memoturn, Span, Trace
from .decorator import get_client


def _map_usage(usage: Optional[dict]) -> Optional[dict]:
    """Best-effort mapping of CrewAI's ``LLMCallCompletedEvent.usage`` dict onto
    memoturn's usage shape. CrewAI (via litellm) normalizes provider usage to
    OpenAI-style ``prompt_tokens``/``completion_tokens``/``total_tokens`` keys, plus
    derived ``cached_prompt_tokens``/``cache_creation_tokens`` buckets flattened out of
    provider-specific nesting — never raises, and returns None for a missing/empty dict
    so callers can omit the field entirely rather than sending an empty usage body."""
    if not usage:
        return None
    try:
        get = usage.get if isinstance(usage, dict) else (lambda k: getattr(usage, k, None))
        out: dict[str, Any] = {
            "promptTokens": get("prompt_tokens"),
            "completionTokens": get("completion_tokens"),
            "totalTokens": get("total_tokens"),
        }
        cache_read = get("cached_prompt_tokens") or get("cached_tokens") or get("cache_read_input_tokens")
        if cache_read is not None:
            out["cacheReadTokens"] = cache_read
        cache_creation = get("cache_creation_tokens") or get("cache_creation_input_tokens")
        if cache_creation is not None:
            out["cacheCreationTokens"] = cache_creation
        return out
    except Exception:  # noqa: BLE001
        return None


def _output_text(output: Any) -> Any:
    """CrewAI's TaskOutput/CrewOutput carry a plain-string ``.raw`` field alongside
    structured pydantic/json variants — prefer it when present, else pass the object
    through as-is (the client JSON-encodes with ``default=str`` at flush time)."""
    try:
        raw = getattr(output, "raw", None)
        return raw if raw else output
    except Exception:  # noqa: BLE001
        return output


def _end(obj: Any, **body: Any) -> None:
    """``.end()``/``.update()`` on a Span/Trace, dropping None-valued kwargs so a
    missing field is omitted rather than sent as an explicit null."""
    try:
        obj.end(**{k: v for k, v in body.items() if v is not None})
    except Exception:  # noqa: BLE001
        pass


def _update(trace: Trace, **body: Any) -> None:
    try:
        trace.update(**{k: v for k, v in body.items() if v is not None})
    except Exception:  # noqa: BLE001
        pass


def instrument_crewai(memoturn: Optional[Memoturn] = None, *, trace_name: str = "crewai") -> None:
    """Register handlers on CrewAI's global event bus that map crew/task/agent/tool/LLM
    execution onto a nested memoturn trace tree. Call once at process startup — CrewAI's
    event bus is a singleton, so there is no per-crew handle to return; every ``Crew``
    kicked off afterward in this process is traced automatically.

    Correlation strategy (CrewAI's events don't carry one single correlation id that
    spans every event family, so each level uses the best key its own events expose):

    - Crews are keyed by ``id(source)`` — the ``Crew`` instance is the emitting
      ``source`` for every ``CrewKickoff*`` event.
    - Tasks are keyed by ``str(task_id)`` — every task-scoped event (``Task*Event``,
      and the ``task_id`` CrewAI stamps onto tool/LLM events) carries the same
      stringified ``Task.id``.
    - Agents are keyed by *both* ``id(agent_object)`` and ``str(agent.id)``, because
      ``AgentExecutionStartedEvent``/``ToolUsageStartedEvent`` carry the raw ``Agent``
      object (so ``id(...)`` works), while ``LLMCallStartedEvent`` only carries the
      stringified ``agent_id`` (CrewAI's ``LLMEventBase.__init__`` consumes
      ``from_agent`` and discards the object reference) — storing both keys against the
      same span lets every event family resolve its parent agent span.
    - Tools are keyed by ``id(source)`` — the emitting ``ToolUsage``/executor object is
      stable across a given tool call's start -> finish/error pair.
    - LLM calls are keyed by ``call_id`` — the one field every ``LLMCall*Event``
      explicitly carries for this purpose.

    Parent resolution at each level falls back task -> agent -> crew trace -> a fresh
    trace, so a malformed or partial event sequence (a level's start event never seen)
    never drops the observation — it just attaches one level higher (or opens a new
    trace) instead of raising.

    Raises ``ImportError`` with an install hint if ``crewai`` isn't importable.
    """
    try:
        from crewai.events import crewai_event_bus
        from crewai.events.types.agent_events import (
            AgentExecutionCompletedEvent,
            AgentExecutionErrorEvent,
            AgentExecutionStartedEvent,
        )
        from crewai.events.types.crew_events import (
            CrewKickoffCompletedEvent,
            CrewKickoffFailedEvent,
            CrewKickoffStartedEvent,
        )
        from crewai.events.types.llm_events import (
            LLMCallCompletedEvent,
            LLMCallFailedEvent,
            LLMCallStartedEvent,
        )
        from crewai.events.types.task_events import TaskCompletedEvent, TaskFailedEvent, TaskStartedEvent
        from crewai.events.types.tool_usage_events import (
            ToolUsageErrorEvent,
            ToolUsageFinishedEvent,
            ToolUsageStartedEvent,
        )
    except ImportError as e:
        raise ImportError(
            "memoturn.crewai.instrument_crewai requires 'crewai' — "
            "install it (`pip install \"memoturn[crewai]\"`) to use the CrewAI integration."
        ) from e

    mt = memoturn or get_client()
    crews: dict[int, Trace] = {}
    tasks: dict[str, Span] = {}
    agents: dict[Any, Span] = {}
    tools: dict[int, Span] = {}
    llm_calls: dict[str, Span] = {}

    def _crew_trace_for_task(task: Any) -> Optional[Trace]:
        # Task doesn't hold a direct crew reference, but the agent assigned to it does
        # (Task.agent is set right before CrewAI emits TaskStartedEvent).
        try:
            agent = getattr(task, "agent", None)
            crew = getattr(agent, "crew", None) if agent is not None else None
            return crews.get(id(crew)) if crew is not None else None
        except Exception:  # noqa: BLE001
            return None

    def _resolve_parent(task_id: Optional[str] = None, agent: Any = None, agent_id: Optional[str] = None) -> Any:
        if task_id and task_id in tasks:
            return tasks[task_id]
        if agent is not None and id(agent) in agents:
            return agents[id(agent)]
        if agent_id and agent_id in agents:
            return agents[agent_id]
        return None

    # ── crew ────────────────────────────────────────────────────────────────
    @crewai_event_bus.on(CrewKickoffStartedEvent)
    def _(source: Any, event: Any) -> None:
        try:
            crews[id(source)] = mt.trace(name=trace_name, input=getattr(event, "inputs", None))
        except Exception:  # noqa: BLE001
            pass

    @crewai_event_bus.on(CrewKickoffCompletedEvent)
    def _(source: Any, event: Any) -> None:
        trace = crews.pop(id(source), None)
        if trace is not None:
            _update(trace, output=_output_text(event.output))

    @crewai_event_bus.on(CrewKickoffFailedEvent)
    def _(source: Any, event: Any) -> None:
        trace = crews.pop(id(source), None)
        if trace is not None:
            _update(trace, level="ERROR", statusMessage=str(event.error))

    # ── task ────────────────────────────────────────────────────────────────
    @crewai_event_bus.on(TaskStartedEvent)
    def _(source: Any, event: Any) -> None:
        try:
            trace = _crew_trace_for_task(event.task) or mt.trace(name=trace_name)
            inp = getattr(event.task, "description", None) or event.context
            tasks[str(event.task_id)] = trace.span(name="task", observationType="CHAIN", input=inp)
        except Exception:  # noqa: BLE001
            pass

    @crewai_event_bus.on(TaskCompletedEvent)
    def _(source: Any, event: Any) -> None:
        span = tasks.pop(str(event.task_id), None)
        if span is not None:
            _end(span, output=_output_text(event.output))

    @crewai_event_bus.on(TaskFailedEvent)
    def _(source: Any, event: Any) -> None:
        span = tasks.pop(str(event.task_id), None)
        if span is not None:
            _end(span, level="ERROR", statusMessage=str(event.error))

    # ── agent ───────────────────────────────────────────────────────────────
    @crewai_event_bus.on(AgentExecutionStartedEvent)
    def _(source: Any, event: Any) -> None:
        try:
            parent = (
                tasks.get(str(getattr(event.task, "id", None)))
                or _crew_trace_for_task(event.task)
                or mt.trace(name=trace_name)
            )
            span = parent.agent(name=getattr(event.agent, "role", "agent"), input=event.task_prompt)
            agents[id(source)] = span
            agent_id = getattr(event.agent, "id", None)
            if agent_id is not None:
                agents[str(agent_id)] = span
        except Exception:  # noqa: BLE001
            pass

    def _pop_agent_span(source: Any, event: Any) -> Optional[Span]:
        span = agents.pop(id(source), None)
        agent_id = getattr(getattr(event, "agent", None), "id", None)
        if agent_id is not None:
            agents.pop(str(agent_id), None)
        return span

    @crewai_event_bus.on(AgentExecutionCompletedEvent)
    def _(source: Any, event: Any) -> None:
        span = _pop_agent_span(source, event)
        if span is not None:
            _end(span, output=event.output)

    @crewai_event_bus.on(AgentExecutionErrorEvent)
    def _(source: Any, event: Any) -> None:
        span = _pop_agent_span(source, event)
        if span is not None:
            _end(span, level="ERROR", statusMessage=str(event.error))

    # ── tool ────────────────────────────────────────────────────────────────
    @crewai_event_bus.on(ToolUsageStartedEvent)
    def _(source: Any, event: Any) -> None:
        try:
            parent = (
                _resolve_parent(event.task_id, getattr(event, "agent", None), event.agent_id)
                or mt.trace(name=trace_name)
            )
            tools[id(source)] = parent.tool(name=event.tool_name, input=event.tool_args)
        except Exception:  # noqa: BLE001
            pass

    @crewai_event_bus.on(ToolUsageFinishedEvent)
    def _(source: Any, event: Any) -> None:
        span = tools.pop(id(source), None)
        if span is not None:
            _end(span, output=event.output)

    @crewai_event_bus.on(ToolUsageErrorEvent)
    def _(source: Any, event: Any) -> None:
        span = tools.pop(id(source), None)
        if span is not None:
            _end(span, level="ERROR", statusMessage=str(event.error))

    # ── LLM ─────────────────────────────────────────────────────────────────
    @crewai_event_bus.on(LLMCallStartedEvent)
    def _(source: Any, event: Any) -> None:
        try:
            parent = _resolve_parent(event.task_id, None, event.agent_id) or mt.trace(name=trace_name)
            model_parameters = {
                k: v
                for k, v in {
                    "temperature": event.temperature,
                    "topP": event.top_p,
                    "maxTokens": event.max_tokens,
                    "stopSequences": event.stop_sequences,
                }.items()
                if v is not None
            }
            llm_calls[event.call_id] = parent.generation(
                name="llm_call", model=event.model, input=event.messages, modelParameters=model_parameters,
            )
        except Exception:  # noqa: BLE001
            pass

    @crewai_event_bus.on(LLMCallCompletedEvent)
    def _(source: Any, event: Any) -> None:
        span = llm_calls.pop(event.call_id, None)
        if span is not None:
            _end(span, output=event.response, usage=_map_usage(event.usage))

    @crewai_event_bus.on(LLMCallFailedEvent)
    def _(source: Any, event: Any) -> None:
        span = llm_calls.pop(event.call_id, None)
        if span is not None:
            _end(span, level="ERROR", statusMessage=str(event.error))
