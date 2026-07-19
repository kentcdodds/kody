CREATE TABLE IF NOT EXISTS feature_flags (
	key TEXT PRIMARY KEY NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	rollout_percent INTEGER CHECK (rollout_percent BETWEEN 0 AND 100),
	note TEXT NOT NULL DEFAULT '',
	updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS feature_flag_user_overrides (
	flag_key TEXT NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
	updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (flag_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_user_overrides_user_id
ON feature_flag_user_overrides(user_id);
