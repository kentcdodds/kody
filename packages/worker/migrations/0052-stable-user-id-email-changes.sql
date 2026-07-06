ALTER TABLE users ADD COLUMN stable_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
	ON users(stable_user_id)
	WHERE stable_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pending_email_changes (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	user_id INTEGER NOT NULL,
	new_email TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_email_changes_user_id
	ON pending_email_changes(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_changes_new_email
	ON pending_email_changes(new_email);

CREATE INDEX IF NOT EXISTS idx_pending_email_changes_token_hash
	ON pending_email_changes(token_hash);
