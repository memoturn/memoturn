-- Prompt-caching token breakdown on generations (e.g. Anthropic prompt caching):
-- cache_read_tokens   = prompt tokens served from cache on this call
-- cache_creation_tokens = prompt tokens written to the cache on this call
-- Additive value columns; existing rows default to 0. Light schema change on the
-- merge-on-write observations table.
ALTER TABLE observations ADD COLUMN cache_read_tokens BIGINT NOT NULL DEFAULT '0' AFTER total_tokens;
ALTER TABLE observations ADD COLUMN cache_creation_tokens BIGINT NOT NULL DEFAULT '0' AFTER cache_read_tokens;
