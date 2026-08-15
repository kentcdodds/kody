-- Thin fleet index for per-user RepoSessionIndex alarms and leftover D1
-- hydrate. One row per user who still has catalog rows. The catalog itself
-- lives in the per-user Durable Object; this table is only a due-work hint
-- plus a platform-owned backfill cursor.
CREATE TABLE repo_session_due_owners (
	user_id TEXT PRIMARY KEY NOT NULL,
	due_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX idx_repo_session_due_owners_due_at
	ON repo_session_due_owners(due_at, user_id);

CREATE TABLE repo_session_index_backfill_cursor (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	position TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);
INSERT INTO repo_session_index_backfill_cursor (singleton, position, updated_at)
VALUES (1, '', datetime('now'));
