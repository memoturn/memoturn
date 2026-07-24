-- Hierarchical, function-organized session path on traces (e.g. "/support/lookup/search").
-- Lets a session's traces be grouped/collapsed by path rather than read as a flat timeline.
-- Additive string column; existing rows default to '' (treated as "no path"). Light schema
-- change on the merge-on-write traces table.
ALTER TABLE traces ADD COLUMN session_path VARCHAR(1024) NOT NULL DEFAULT '' AFTER session_id;
