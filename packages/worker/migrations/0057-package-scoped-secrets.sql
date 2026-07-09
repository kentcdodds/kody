CREATE TABLE secret_buckets_new (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('session', 'package', 'user')),
	binding_key TEXT NOT NULL,
	expires_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE(user_id, scope, binding_key)
);

INSERT INTO secret_buckets_new (
	id,
	user_id,
	scope,
	binding_key,
	expires_at,
	created_at,
	updated_at
)
SELECT
	id,
	user_id,
	CASE scope WHEN 'app' THEN 'package' ELSE scope END,
	binding_key,
	expires_at,
	created_at,
	updated_at
FROM secret_buckets;

CREATE TABLE secret_entries_new (
	bucket_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	encrypted_value TEXT NOT NULL,
	allowed_hosts TEXT NOT NULL DEFAULT '[]',
	allowed_capabilities TEXT NOT NULL DEFAULT '[]',
	lookup_hash TEXT,
	allowed_packages TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (bucket_id, name),
	FOREIGN KEY (bucket_id) REFERENCES secret_buckets_new(id) ON DELETE CASCADE
);

INSERT INTO secret_entries_new (
	bucket_id,
	name,
	description,
	encrypted_value,
	allowed_hosts,
	allowed_capabilities,
	lookup_hash,
	allowed_packages,
	created_at,
	updated_at
)
SELECT
	bucket_id,
	name,
	description,
	encrypted_value,
	allowed_hosts,
	allowed_capabilities,
	lookup_hash,
	CASE
		WHEN bucket_id IN (
			SELECT id FROM secret_buckets WHERE scope = 'user'
		)
		THEN allowed_packages
		ELSE '[]'
	END,
	created_at,
	updated_at
FROM secret_entries;

DROP TABLE secret_entries;
DROP TABLE secret_buckets;

ALTER TABLE secret_buckets_new RENAME TO secret_buckets;
ALTER TABLE secret_entries_new RENAME TO secret_entries;

CREATE INDEX idx_secret_buckets_user_scope_binding
	ON secret_buckets(user_id, scope, binding_key);
CREATE INDEX idx_secret_entries_bucket_id
	ON secret_entries(bucket_id);
CREATE INDEX idx_secret_entries_name
	ON secret_entries(name);
CREATE INDEX idx_secret_entries_lookup_hash
	ON secret_entries(lookup_hash);

UPDATE jobs
SET caller_context_json = json_set(
	caller_context_json,
	'$.storageContext.packageId',
	(
		SELECT p.id
		FROM saved_packages AS p
		WHERE p.user_id = jobs.user_id
			AND p.id = json_extract(
				jobs.caller_context_json,
				'$.storageContext.appId'
			)
		LIMIT 1
	)
)
WHERE json_valid(caller_context_json)
	AND EXISTS (
		SELECT 1
		FROM saved_packages AS p
		WHERE p.user_id = jobs.user_id
			AND p.id = json_extract(
				jobs.caller_context_json,
				'$.storageContext.appId'
			)
	);
