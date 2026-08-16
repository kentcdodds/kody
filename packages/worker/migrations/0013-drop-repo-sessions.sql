-- Phase 2: leftover D1 catalog is empty. Catalog authority is RepoSessionIndex.
-- Indexes on repo_sessions drop with the table. The hydrate cursor is retired
-- with the backfill lane.
DROP TABLE IF EXISTS repo_sessions;
DROP TABLE IF EXISTS repo_session_index_backfill_cursor;
