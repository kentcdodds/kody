-- Durable Vectorize cleanup marker for soft-deleted memories.
-- NULL means Vectorize delete is still pending (including all pre-existing
-- soft-deleted rows after this additive column lands). Successful deletes set
-- vector_deleted_at so later purge retries skip clean rows and reach older
-- stranded ones within the per-org memoryLimit budget.

ALTER TABLE mcp_memories ADD COLUMN vector_deleted_at TEXT;
