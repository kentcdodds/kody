-- Credentials plan v4 (ADR 0068): an admin fleet inventory of credential
-- placeholders in published package source. A run pages through saved
-- packages; each item holds one package's content-free result (credential
-- ids, placement shapes, slot providers and placeholder counts, never a
-- credential name or value). `adminCredentialBackfill` reads a complete run
-- to fill `provider` and `inject_json` on credential rows.

CREATE TABLE credential_inventory_runs (
	id TEXT PRIMARY KEY NOT NULL,
	initiated_by_user_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('scanning', 'complete')),
	cursor TEXT,
	backfilled_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE credential_inventory_items (
	run_id TEXT NOT NULL REFERENCES credential_inventory_runs (id) ON DELETE CASCADE,
	package_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('scanned', 'unpublished', 'failed')),
	result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
	created_at TEXT NOT NULL,
	PRIMARY KEY (run_id, package_id)
);

CREATE INDEX credential_inventory_items_user ON credential_inventory_items (user_id);
