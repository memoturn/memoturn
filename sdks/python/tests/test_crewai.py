"""CrewAI instrumentation — event-bus registration builds a nested trace tree."""
from __future__ import annotations

import builtins
import datetime

import pytest

from conftest import Capture

from memoturn import Memoturn
from memoturn.crewai import instrument_crewai

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def test_raises_clear_import_error_when_crewai_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Doesn't need a real install — blocks the import so this path is always exercised."""
    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "crewai" or name.startswith("crewai."):
            raise ImportError("simulated missing dependency")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(ImportError, match="memoturn.crewai.instrument_crewai requires 'crewai'"):
        instrument_crewai()


# Everything below needs the real optional dependency. A module-level
# ``pytest.importorskip`` would abort collection of the *whole file* — including the
# always-runnable ImportError test above — so the presence check is a plain
# try/except and each dependent test is skipped individually instead.
try:
    from crewai import Agent, Task
    from crewai.crews.crew_output import CrewOutput
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
        LLMCallType,
    )
    from crewai.events.types.task_events import TaskCompletedEvent, TaskFailedEvent, TaskStartedEvent
    from crewai.events.types.tool_usage_events import (
        ToolUsageErrorEvent,
        ToolUsageFinishedEvent,
        ToolUsageStartedEvent,
    )
    from crewai.tasks.task_output import TaskOutput

    _HAS_CREWAI = True
except ImportError:
    _HAS_CREWAI = False

requires_crewai = pytest.mark.skipif(not _HAS_CREWAI, reason="crewai is not installed")


def _emit(source: object, event: object) -> None:
    future = crewai_event_bus.emit(source, event)
    if future is not None:
        future.result(timeout=5.0)


def _agent_task() -> tuple:
    agent = Agent(role="researcher", goal="find stuff", backstory="a researcher")
    task = Task(description="do the research", expected_output="a report", agent=agent)
    return agent, task


@requires_crewai
def test_full_crew_task_agent_tool_llm_nesting(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    with crewai_event_bus.scoped_handlers():
        instrument_crewai(client, trace_name="crew-run")

        agent, task = _agent_task()
        crew = object()  # crew identity only matters for id()-correlation here
        agent.crew = crew  # normally set by Crew at kickoff time

        _emit(crew, CrewKickoffStartedEvent(crew_name="research-crew", inputs={"topic": "memoturn"}))
        _emit(task, TaskStartedEvent(context=None, task=task))
        _emit(agent, AgentExecutionStartedEvent(agent=agent, tools=[], task_prompt="do the research", task=task))

        tool_source = object()
        _emit(
            tool_source,
            ToolUsageStartedEvent(tool_name="search", tool_args={"q": "memoturn"}, from_agent=agent, from_task=task),
        )
        _emit(
            tool_source,
            ToolUsageFinishedEvent(
                tool_name="search", tool_args={"q": "memoturn"}, from_agent=agent, from_task=task,
                started_at=datetime.datetime.now(), finished_at=datetime.datetime.now(),
                output="3 results",
            ),
        )

        llm_source = object()
        _emit(
            llm_source,
            LLMCallStartedEvent(
                call_id="call-1", model="gpt-4o", from_agent=agent, from_task=task,
                messages=[{"role": "user", "content": "go"}], temperature=0.2, top_p=0.9,
                max_tokens=256, stop_sequences=["END"],
            ),
        )
        _emit(
            llm_source,
            LLMCallCompletedEvent(
                call_id="call-1", model="gpt-4o", from_agent=agent, from_task=task,
                messages=[{"role": "user", "content": "go"}], response="the answer", call_type=LLMCallType.LLM_CALL,
                usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            ),
        )

        _emit(
            agent,
            AgentExecutionCompletedEvent(agent=agent, task=task, output="agent finished"),
        )
        _emit(
            task,
            TaskCompletedEvent(output=TaskOutput(description="do the research", raw="final report", agent="researcher"), task=task),
        )
        _emit(crew, CrewKickoffCompletedEvent(crew_name="research-crew", output=CrewOutput(raw="crew done")))

        client.flush()

    batch = capture.batch()
    trace = next(e for e in batch if e["type"] == "trace-create")
    assert trace["body"]["name"] == "crew-run"
    assert trace["body"]["input"] == {"topic": "memoturn"}
    trace_id = trace["body"]["id"]

    task_span = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "task")
    assert task_span["body"]["observationType"] == "CHAIN"
    assert task_span["body"]["traceId"] == trace_id
    assert task_span["body"]["input"] == "do the research"

    agent_span = next(e for e in batch if e["type"] == "span-create" and e["body"]["observationType"] == "AGENT")
    assert agent_span["body"]["parentObservationId"] == task_span["body"]["id"]
    assert agent_span["body"]["name"] == "researcher"

    tool_span = next(e for e in batch if e["type"] == "span-create" and e["body"]["observationType"] == "TOOL")
    assert tool_span["body"]["parentObservationId"] == task_span["body"]["id"]
    assert tool_span["body"]["input"] == {"q": "memoturn"}
    tool_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == tool_span["body"]["id"])
    assert tool_end["body"]["output"] == "3 results"

    gen = next(e for e in batch if e["type"] == "generation-create")
    assert gen["body"]["parentObservationId"] == task_span["body"]["id"]
    assert gen["body"]["model"] == "gpt-4o"
    assert gen["body"]["modelParameters"] == {
        "temperature": 0.2, "topP": 0.9, "maxTokens": 256, "stopSequences": ["END"],
    }
    gen_end = next(e for e in batch if e["type"] == "generation-update")
    assert gen_end["body"]["output"] == "the answer"
    assert gen_end["body"]["usage"] == {"promptTokens": 10, "completionTokens": 5, "totalTokens": 15}

    agent_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == agent_span["body"]["id"])
    assert agent_end["body"]["output"] == "agent finished"

    task_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == task_span["body"]["id"])
    assert task_end["body"]["output"] == "final report"

    trace_updates = [e for e in batch if e["type"] == "trace-create" and e["body"]["id"] == trace_id]
    assert trace_updates[-1]["body"]["output"] == "crew done"


@requires_crewai
def test_error_paths_mark_level_error(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    with crewai_event_bus.scoped_handlers():
        instrument_crewai(client, trace_name="crew-run")

        agent, task = _agent_task()
        crew = object()

        _emit(crew, CrewKickoffStartedEvent(crew_name="failing-crew", inputs=None))
        _emit(task, TaskStartedEvent(context=None, task=task))
        _emit(agent, AgentExecutionStartedEvent(agent=agent, tools=[], task_prompt="do it", task=task))

        tool_source = object()
        _emit(tool_source, ToolUsageStartedEvent(tool_name="search", tool_args={}, from_agent=agent, from_task=task))
        _emit(
            tool_source,
            ToolUsageErrorEvent(tool_name="search", tool_args={}, from_agent=agent, from_task=task, error="tool boom"),
        )

        llm_source = object()
        _emit(llm_source, LLMCallStartedEvent(call_id="call-err", model="gpt-4o", from_agent=agent, from_task=task))
        _emit(llm_source, LLMCallFailedEvent(call_id="call-err", model="gpt-4o", error="llm boom"))

        _emit(agent, AgentExecutionErrorEvent(agent=agent, task=task, error="agent boom"))
        _emit(task, TaskFailedEvent(error="task boom", task=task))
        _emit(crew, CrewKickoffFailedEvent(crew_name="failing-crew", error="crew boom"))

        client.flush()

    batch = capture.batch()

    tool_end = next(e for e in batch if e["type"] == "span-update" and e["body"].get("statusMessage") == "tool boom")
    assert tool_end["body"]["level"] == "ERROR"

    gen_end = next(e for e in batch if e["type"] == "generation-update")
    assert gen_end["body"]["level"] == "ERROR"
    assert gen_end["body"]["statusMessage"] == "llm boom"

    agent_end = next(e for e in batch if e["type"] == "span-update" and e["body"].get("statusMessage") == "agent boom")
    assert agent_end["body"]["level"] == "ERROR"

    task_end = next(e for e in batch if e["type"] == "span-update" and e["body"].get("statusMessage") == "task boom")
    assert task_end["body"]["level"] == "ERROR"

    trace_updates = [e for e in batch if e["type"] == "trace-create"]
    failed_trace = next(e for e in trace_updates if e["body"].get("statusMessage") == "crew boom")
    assert failed_trace["body"]["level"] == "ERROR"
