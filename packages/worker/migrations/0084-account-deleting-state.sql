ALTER TABLE users ADD COLUMN deleting_at TEXT;

CREATE INDEX idx_users_deleting_at
ON users(deleting_at)
WHERE deleting_at IS NOT NULL;
