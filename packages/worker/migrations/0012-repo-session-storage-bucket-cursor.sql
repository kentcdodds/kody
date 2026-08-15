-- Platform-owned cursor for storage-bucket inventory reconciliation across
-- RepoSessionIndex owners. One singleton row. Column is `position` (not a
-- *_user_id name) so data-targets does not treat it as user data.
CREATE TABLE repo_session_storage_bucket_cursor (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	position TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);
INSERT INTO repo_session_storage_bucket_cursor (singleton, position, updated_at)
VALUES (1, '', datetime('now'));
