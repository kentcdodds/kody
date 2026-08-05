CREATE TABLE user_storage_buckets_next (
	user_id TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (
		kind IN ('job', 'package', 'service', 'execute', 'repo_session', 'unknown')
	),
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	estimated_bytes INTEGER,
	estimated_bytes_updated_at TEXT,
	PRIMARY KEY (user_id, storage_id)
);

INSERT INTO user_storage_buckets_next (
	user_id,
	storage_id,
	kind,
	created_at,
	last_seen_at,
	estimated_bytes,
	estimated_bytes_updated_at
)
SELECT
	user_id,
	storage_id,
	kind,
	created_at,
	last_seen_at,
	estimated_bytes,
	estimated_bytes_updated_at
FROM user_storage_buckets;

DROP TABLE user_storage_buckets;

ALTER TABLE user_storage_buckets_next RENAME TO user_storage_buckets;

CREATE INDEX idx_user_storage_buckets_user
ON user_storage_buckets(user_id);
