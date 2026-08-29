-- Drop the retired per-secret capability allowlist. Rebuild instead of
-- ALTER TABLE DROP COLUMN so the migration is idempotent: preview already
-- applied the drop under the pre-rebase 0031 filename, then this file was
-- renumbered to 0032 after main took 0031.
--
-- SELECT lists the retained columns, so the copy succeeds whether
-- allowed_capabilities is still present or already gone.
DROP TABLE IF EXISTS secret_entries__no_allowed_capabilities;

CREATE TABLE secret_entries__no_allowed_capabilities (
	bucket_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	encrypted_value TEXT NOT NULL,
	allowed_hosts TEXT NOT NULL DEFAULT '[]',
	lookup_hash TEXT,
	allowed_packages TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	expires_at TEXT,
	PRIMARY KEY (bucket_id, name),
	FOREIGN KEY (bucket_id) REFERENCES secret_buckets (id) ON DELETE CASCADE
);

INSERT INTO secret_entries__no_allowed_capabilities (
	bucket_id,
	name,
	description,
	encrypted_value,
	allowed_hosts,
	lookup_hash,
	allowed_packages,
	created_at,
	updated_at,
	expires_at
)
SELECT
	bucket_id,
	name,
	description,
	encrypted_value,
	allowed_hosts,
	lookup_hash,
	allowed_packages,
	created_at,
	updated_at,
	expires_at
FROM secret_entries;

DROP TABLE secret_entries;

ALTER TABLE secret_entries__no_allowed_capabilities RENAME TO secret_entries;

CREATE INDEX IF NOT EXISTS idx_secret_entries_bucket_id
ON secret_entries (bucket_id);

CREATE INDEX IF NOT EXISTS idx_secret_entries_name
ON secret_entries (name);

CREATE INDEX IF NOT EXISTS idx_secret_entries_lookup_hash
ON secret_entries (lookup_hash);
