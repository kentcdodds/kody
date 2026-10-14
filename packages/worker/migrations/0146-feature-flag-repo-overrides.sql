-- Per-repo feature flag allowlist (repo-scoped flags such as repo-push-queue).
-- Keyed by entity_sources.id so a rename never changes the assignment.
-- Operator configuration, not user content. No foreign keys: table rebuilds
-- of entity_sources or users must not cascade-delete operator rollout state,
-- and a row for a deleted source never matches a live push.
CREATE TABLE feature_flag_repo_overrides (
	flag_key TEXT NOT NULL,
	source_id TEXT NOT NULL,
	enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
	updated_by TEXT,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (flag_key, source_id)
);
