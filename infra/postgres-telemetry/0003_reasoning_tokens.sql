-- Reasoning/thinking token attribution on generations. Mirrors infra/doris/0006_reasoning_tokens.sql.
--
-- reasoning_tokens is a SUBSET of completion_tokens (providers bill reasoning at the output
-- rate and already count it there), so it is attributional only and must never be added to
-- the cost columns. Additive; existing rows default to 0.
ALTER TABLE telemetry.observations ADD COLUMN IF NOT EXISTS reasoning_tokens bigint NOT NULL DEFAULT 0;
