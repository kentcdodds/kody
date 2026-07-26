-- Authoritative per-user durable storage bucket ownership.
--
-- "Which storage buckets does this user own?" is state, not history. Deriving
-- it from `package_runtime_runs` was wrong: that table stopped being written
-- (RunLog migration) and will drain under the 30-day retention policy. Ad-hoc
-- buckets (caller-supplied `storageId` on execute / storage capabilities) have
-- no other D1 record, so they would become unenumerable for backup, account
-- export, and account deletion.
--
-- This table is written on mutating StorageRunner access. The
-- `package_runtime_runs` arm below is a one-time rescue of pre-migration
-- buckets and is why this migration could not wait for the legacy drop.

CREATE TABLE IF NOT EXISTS user_storage_buckets (
	user_id TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('job', 'app', 'service', 'execute', 'unknown')),
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	PRIMARY KEY (user_id, storage_id)
);

CREATE INDEX IF NOT EXISTS idx_user_storage_buckets_user
ON user_storage_buckets(user_id);

INSERT OR IGNORE INTO user_storage_buckets (
	user_id, storage_id, kind, created_at, last_seen_at
)
SELECT
	user_id,
	storage_id,
	'job',
	created_at,
	updated_at
FROM jobs
WHERE storage_id IS NOT NULL AND trim(storage_id) != '';

INSERT OR IGNORE INTO user_storage_buckets (
	user_id, storage_id, kind, created_at, last_seen_at
)
SELECT
	user_id,
	storage_id,
	'job',
	created_at,
	updated_at
FROM archived_job_artifacts
WHERE storage_id IS NOT NULL AND trim(storage_id) != '';

INSERT OR IGNORE INTO user_storage_buckets (
	user_id, storage_id, kind, created_at, last_seen_at
)
SELECT
	user_id,
	id,
	'app',
	created_at,
	updated_at
FROM saved_packages
WHERE has_app = 1;

-- One-time rescue of pre-migration buckets (including ad-hoc execute/storage
-- ids) that only survive in run history until ~2026-08-25 retention drain.
INSERT OR IGNORE INTO user_storage_buckets (
	user_id, storage_id, kind, created_at, last_seen_at
)
SELECT
	user_id,
	storage_id,
	CASE surface
		WHEN 'job' THEN 'job'
		WHEN 'service' THEN 'service'
		WHEN 'app_fetch' THEN 'app'
		WHEN 'app_realtime' THEN 'app'
		ELSE 'unknown'
	END,
	COALESCE(started_at, created_at, CURRENT_TIMESTAMP),
	COALESCE(updated_at, finished_at, started_at, created_at, CURRENT_TIMESTAMP)
FROM package_runtime_runs
WHERE storage_id IS NOT NULL AND trim(storage_id) != '';
