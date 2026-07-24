-- Hierarchical, function-organized session path on traces (e.g. "/support/lookup/search").
-- Mirrors infra/doris/0005_session_path.sql. Additive; existing rows default to ''. A partial
-- index supports filtering/grouping by path within a project (only non-empty paths indexed).
ALTER TABLE telemetry.traces ADD COLUMN IF NOT EXISTS session_path text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS traces_project_session_path_idx
    ON telemetry.traces (project_id, session_path) WHERE session_path <> '';
