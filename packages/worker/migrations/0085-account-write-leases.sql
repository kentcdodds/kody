ALTER TABLE users ADD COLUMN active_write_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN active_write_expires_at TEXT;
