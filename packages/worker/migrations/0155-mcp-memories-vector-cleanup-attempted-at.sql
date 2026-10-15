-- Rotate stranded Vectorize cleanup across soft-deleted memories.
-- After a failed delete attempt, vector_cleanup_attempted_at is set so the
-- next pending page prefers never-attempted and older-attempted rows instead
-- of sticking on the same permanently failing ids.

ALTER TABLE mcp_memories ADD COLUMN vector_cleanup_attempted_at TEXT;
