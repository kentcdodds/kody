-- Expand user_storage_buckets.kind to recognize package: buckets (from
-- packageStorage()). SQLite cannot ALTER a CHECK constraint in place, so the
-- table is rebuilt. Existing package:/service: rows previously stored as
-- 'unknown' are reclassified.

CREATE TABLE user_storage_buckets_next (
	user_id TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('job', 'app', 'package', 'service', 'execute', 'unknown')),
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	PRIMARY KEY (user_id, storage_id)
);

INSERT INTO user_storage_buckets_next (
	user_id, storage_id, kind, created_at, last_seen_at
)
SELECT
	user_id,
	storage_id,
	CASE
		WHEN storage_id LIKE 'package:%' THEN 'package'
		WHEN storage_id LIKE 'service:%' THEN 'service'
		ELSE kind
	END,
	created_at,
	last_seen_at
FROM user_storage_buckets;

DROP TABLE user_storage_buckets;

ALTER TABLE user_storage_buckets_next RENAME TO user_storage_buckets;

CREATE INDEX IF NOT EXISTS idx_user_storage_buckets_user
ON user_storage_buckets(user_id);
