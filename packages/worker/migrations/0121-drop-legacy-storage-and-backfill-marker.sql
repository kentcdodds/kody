-- Reap two completed legacy migrations:
-- 1. Raw package-id app StorageRunner buckets were cleared in production and
--    verified absent on 2026-07-31.
-- 2. The MCP agent-session deployment backfill marker was fully reaped by
--    #1086 and has no remaining application references.
--
-- Fail closed if an app bucket inventory row reappears. Deleting the D1 row
-- without first clearing its StorageRunner would make that Durable Object
-- unenumerable, so operators must use the cleanup capability before deploying
-- this migration.

DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'user_storage_buckets still contains legacy app rows; aborting 0121.'
WHERE EXISTS (
	SELECT 1
	FROM user_storage_buckets
	WHERE kind = 'app'
);

DROP TABLE __migration_assertions;

DROP TABLE IF EXISTS deployment_backfill_markers;

-- SQLite cannot alter a CHECK constraint in place, so rebuild the inventory
-- without the retired app kind.
CREATE TABLE user_storage_buckets_next (
	user_id TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (
		kind IN ('job', 'package', 'service', 'execute', 'unknown')
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

CREATE INDEX IF NOT EXISTS idx_user_storage_buckets_user
ON user_storage_buckets(user_id);
