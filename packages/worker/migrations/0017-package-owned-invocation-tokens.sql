-- Invocation tokens belong to one saved package. Auth looks up
-- (user_id, package_id, token_hash) after the URL names the owner and
-- package. Cross-package grant columns and denormalized identity drop.
--
-- Single-package grants map onto package_id. Multi-package grants expand
-- into one row per owned package (same hash, new ids) in the rebuilt
-- table. Rows that still cannot resolve — including `*` — are dropped.

ALTER TABLE package_invocation_tokens ADD COLUMN package_id TEXT;

UPDATE package_invocation_tokens
SET package_id = (
	SELECT sp.id
	FROM saved_packages sp
	WHERE sp.user_id = package_invocation_tokens.user_id
		AND json_array_length(package_invocation_tokens.package_ids_json) = 1
		AND json_extract(package_invocation_tokens.package_ids_json, '$[0]') NOT IN ('', '*')
		AND json_extract(package_invocation_tokens.package_ids_json, '$[0]') = sp.id
)
WHERE package_id IS NULL
	AND (
		json_array_length(package_kody_ids_json) = 0
		OR (
			json_array_length(package_kody_ids_json) = 1
			AND json_extract(package_kody_ids_json, '$[0]') IN ('', '*')
		)
	);

UPDATE package_invocation_tokens
SET package_id = (
	SELECT sp.id
	FROM saved_packages sp
	WHERE sp.user_id = package_invocation_tokens.user_id
		AND json_array_length(package_invocation_tokens.package_kody_ids_json) = 1
		AND json_extract(package_invocation_tokens.package_kody_ids_json, '$[0]') NOT IN ('', '*')
		AND json_extract(package_invocation_tokens.package_kody_ids_json, '$[0]') = sp.kody_id
)
WHERE package_id IS NULL
	AND (
		json_array_length(package_ids_json) = 0
		OR (
			json_array_length(package_ids_json) = 1
			AND json_extract(package_ids_json, '$[0]') IN ('', '*')
		)
	);

CREATE TABLE package_invocation_tokens_owned (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	export_names_json TEXT NOT NULL DEFAULT '[]',
	sources_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);

INSERT INTO package_invocation_tokens_owned (
	id,
	user_id,
	package_id,
	name,
	token_hash,
	export_names_json,
	sources_json,
	created_at,
	updated_at,
	last_used_at,
	revoked_at
)
SELECT
	id,
	user_id,
	package_id,
	name,
	token_hash,
	export_names_json,
	sources_json,
	created_at,
	updated_at,
	last_used_at,
	revoked_at
FROM package_invocation_tokens
WHERE package_id IS NOT NULL;

INSERT INTO package_invocation_tokens_owned (
	id,
	user_id,
	package_id,
	name,
	token_hash,
	export_names_json,
	sources_json,
	created_at,
	updated_at,
	last_used_at,
	revoked_at
)
SELECT
	lower(hex(randomblob(16))),
	t.user_id,
	sp.id,
	t.name,
	t.token_hash,
	t.export_names_json,
	t.sources_json,
	t.created_at,
	t.updated_at,
	t.last_used_at,
	t.revoked_at
FROM package_invocation_tokens t
JOIN json_each(t.package_ids_json) AS j
JOIN saved_packages sp
	ON sp.user_id = t.user_id
	AND sp.id = j.value
WHERE t.package_id IS NULL
	AND j.value NOT IN ('', '*');

INSERT INTO package_invocation_tokens_owned (
	id,
	user_id,
	package_id,
	name,
	token_hash,
	export_names_json,
	sources_json,
	created_at,
	updated_at,
	last_used_at,
	revoked_at
)
SELECT
	lower(hex(randomblob(16))),
	t.user_id,
	sp.id,
	t.name,
	t.token_hash,
	t.export_names_json,
	t.sources_json,
	t.created_at,
	t.updated_at,
	t.last_used_at,
	t.revoked_at
FROM package_invocation_tokens t
JOIN json_each(t.package_kody_ids_json) AS j
JOIN saved_packages sp
	ON sp.user_id = t.user_id
	AND sp.kody_id = j.value
WHERE t.package_id IS NULL
	AND j.value NOT IN ('', '*')
	AND NOT EXISTS (
		SELECT 1
		FROM package_invocation_tokens_owned o
		WHERE o.user_id = t.user_id
			AND o.package_id = sp.id
			AND o.token_hash = t.token_hash
	);

DROP TABLE package_invocation_tokens;
ALTER TABLE package_invocation_tokens_owned RENAME TO package_invocation_tokens;

CREATE INDEX idx_package_invocation_tokens_user_package
ON package_invocation_tokens(user_id, package_id);

CREATE UNIQUE INDEX idx_package_invocation_tokens_user_package_hash
ON package_invocation_tokens(user_id, package_id, token_hash);
