CREATE TABLE deployment_backfill_markers (
	key TEXT PRIMARY KEY NOT NULL,
	version INTEGER NOT NULL,
	completed_at TEXT NOT NULL,
	audit_summary_json TEXT NOT NULL
);
