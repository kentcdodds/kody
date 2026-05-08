CREATE TABLE IF NOT EXISTS remote_connector_settings (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	attached INTEGER NOT NULL DEFAULT 1 CHECK (attached IN (0, 1)),
	encrypted_shared_secret TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	UNIQUE(user_id, kind, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_remote_connector_settings_ref_enabled
	ON remote_connector_settings(kind, instance_id, enabled);
