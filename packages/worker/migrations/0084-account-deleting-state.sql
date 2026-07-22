ALTER TABLE users ADD COLUMN deleting_at TEXT;
ALTER TABLE users ADD COLUMN active_write_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_users_deleting_at
ON users(deleting_at)
WHERE deleting_at IS NOT NULL;
