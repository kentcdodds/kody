-- Per-repo Cloudflare Artifacts push event subscription ids
-- (cf.artifacts.repo.pushed). Side table keeps ADD COLUMN off entity_sources
-- so re-applies and rename races stay idempotent via CREATE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS entity_source_artifacts_push_subscriptions (
	source_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	repo_id TEXT NOT NULL,
	subscription_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_source_artifacts_push_subscriptions_repo_id
	ON entity_source_artifacts_push_subscriptions(repo_id);
