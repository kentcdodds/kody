DROP INDEX IF EXISTS idx_remote_connector_settings_ref_enabled;

CREATE TABLE remote_connector_settings_new (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	attached INTEGER NOT NULL DEFAULT 1 CHECK (attached IN (0, 1)),
	encrypted_shared_secret TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	UNIQUE(user_id, instance_id)
);

INSERT INTO remote_connector_settings_new (
	id,
	user_id,
	instance_id,
	enabled,
	attached,
	encrypted_shared_secret,
	created_at,
	updated_at
)
SELECT
	r.id,
	r.user_id,
	LOWER(r.instance_id),
	r.enabled,
	r.attached,
	r.encrypted_shared_secret,
	r.created_at,
	r.updated_at
FROM remote_connector_settings AS r
INNER JOIN (
	SELECT user_id, LOWER(instance_id) AS normalized_instance_id, MIN(rowid) AS min_rowid
	FROM remote_connector_settings
	GROUP BY user_id, LOWER(instance_id)
) AS winners
	ON r.rowid = winners.min_rowid;

DROP TABLE remote_connector_settings;

ALTER TABLE remote_connector_settings_new RENAME TO remote_connector_settings;

CREATE INDEX IF NOT EXISTS idx_remote_connector_settings_ref_enabled
	ON remote_connector_settings(instance_id, enabled);
