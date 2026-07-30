-- Ledger for package codemod runs (fleet or per-user) and per-package items.
-- Runs track scan / dry-run / apply / revert; items record status, commits,
-- findings, check summaries, and KV revert snapshot keys so operators can
-- page, audit, and revert.

CREATE TABLE IF NOT EXISTS package_codemod_runs (
	id TEXT PRIMARY KEY NOT NULL,
	codemod_id TEXT NOT NULL,
	mode TEXT NOT NULL,
	scope_user_id TEXT,
	initiated_by_user_id TEXT NOT NULL,
	filters_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL,
	revert_of_run_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS package_codemod_run_items (
	id TEXT PRIMARY KEY NOT NULL,
	run_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	kody_id TEXT NOT NULL,
	status TEXT NOT NULL,
	before_commit TEXT,
	after_commit TEXT,
	changed_paths_json TEXT NOT NULL DEFAULT '[]',
	findings_json TEXT NOT NULL DEFAULT '[]',
	check_summary_json TEXT,
	error TEXT,
	revert_snapshot_key TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_package_codemod_run_items_run_id
ON package_codemod_run_items(run_id);

CREATE INDEX IF NOT EXISTS idx_package_codemod_runs_codemod_created
ON package_codemod_runs(codemod_id, created_at);
