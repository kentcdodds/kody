-- Durable debt for deferred saved-package vector upserts. When publish/install
-- moves `upsertSavedPackageVector` off the response critical path via
-- waitUntil, a row is written first so an isolate death or deferred failure
-- cannot leave search silently stale. Capability reindex clears debt after a
-- successful upsert; failures keep the row and report to Sentry.
CREATE TABLE saved_package_search_index_debt (
	package_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_saved_package_search_index_debt_user_id
ON saved_package_search_index_debt(user_id);
