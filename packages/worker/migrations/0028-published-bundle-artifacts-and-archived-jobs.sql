CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	published_commit TEXT NOT NULL,
	artifact_kind TEXT NOT NULL,
	artifact_name TEXT,
	entry_point TEXT NOT NULL,
	kv_key TEXT NOT NULL,
	dependencies_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_published_bundle_artifacts_source_identity
ON published_bundle_artifacts(
	user_id,
	source_id,
	artifact_kind,
	COALESCE(artifact_name, ''),
	entry_point
);

CREATE INDEX IF NOT EXISTS idx_published_bundle_artifacts_user_id
ON published_bundle_artifacts(user_id);

CREATE INDEX IF NOT EXISTS idx_published_bundle_artifacts_source_id
ON published_bundle_artifacts(source_id);

CREATE TABLE IF NOT EXISTS archived_job_artifacts (
	job_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	published_commit TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	retain_until TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archived_job_artifacts_user_id
ON archived_job_artifacts(user_id);

CREATE INDEX IF NOT EXISTS idx_archived_job_artifacts_retain_until
ON archived_job_artifacts(retain_until);
