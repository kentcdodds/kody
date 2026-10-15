-- Durable Vectorize cleanup markers for soft-deleted memories.
-- vector_deleted_at NULL means Vectorize delete is still pending (including
-- all pre-existing soft-deleted rows after this additive column lands).
-- Successful deletes set vector_deleted_at so later purge retries skip clean
-- rows. vector_cleanup_attempted_at records the last failed (or in-progress)
-- retry so persistently failing oldest rows do not starve newer pending ones
-- within the per-org memoryLimit budget.

ALTER TABLE mcp_memories ADD COLUMN vector_deleted_at TEXT;
ALTER TABLE mcp_memories ADD COLUMN vector_cleanup_attempted_at TEXT;
