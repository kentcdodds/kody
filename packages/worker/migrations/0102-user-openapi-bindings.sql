-- First-class OpenAPI provider bindings, replacing `_openapi:*` value blobs.
--
-- Per-operation child rows keep every row small instead of rewriting a
-- up-to-900KB JSON blob on each `openapi_binding_refresh`. Staying in D1 (vs
-- KV/R2) keeps the data move a pure SQL migration and keeps per-user isolation
-- structural via composite keys, matching the `user_oauth_apps` /
-- `user_integrations` design from migration 0101.
--
-- Backfill reads user-scoped `_openapi:*` values, inserts one binding row plus
-- one operation row per `$.operations` element, asserts every source row is
-- migratable (fail loudly rather than silently dropping unknown data), then
-- deletes all user-scope `_openapi:*` value rows.
--
-- Migratable name/value predicate (must stay identical across capture INSERT,
-- DELETE, and assertions — only the entry alias differs):
--   <entry>.name LIKE '\_openapi:%' ESCAPE '\'
--   AND length(substr(<entry>.name, 10)) > 0
--   AND length(substr(<entry>.name, 10)) <= 64
--   AND substr(<entry>.name, 10) = trim(substr(<entry>.name, 10))
--   AND substr(<entry>.name, 10) = lower(substr(<entry>.name, 10))
--   AND substr(<entry>.name, 10) GLOB '[a-z0-9]*'
--   AND substr(<entry>.name, 10) NOT GLOB '*[^a-z0-9_-]*'
--   AND json_valid(<entry>.value)
--   AND json_extract(<entry>.value, '$.specUrl') IS NOT NULL
--   AND trim(json_extract(<entry>.value, '$.specUrl')) != ''
--   AND json_extract(<entry>.value, '$.apiBaseUrl') IS NOT NULL
--   AND trim(json_extract(<entry>.value, '$.apiBaseUrl')) != ''
--   AND json_extract(<entry>.value, '$.auth') IS NOT NULL
--   AND json_extract(<entry>.value, '$.selection') IS NOT NULL
--   AND json_array_length(json_extract(<entry>.value, '$.operations')) >= 1
--   AND NOT EXISTS (
--     SELECT 1
--     FROM json_each(<entry>.value, '$.operations') AS op
--     WHERE typeof(json_extract(op.value, '$.slug')) != 'text'
--       OR trim(json_extract(op.value, '$.slug')) = ''
--   )
--   AND NOT EXISTS (
--     SELECT 1
--     FROM json_each(<entry>.value, '$.operations') AS op
--     GROUP BY json_extract(op.value, '$.slug')
--     HAVING count(*) > 1
--   )
-- The name checks mirror openApiBindingNamePattern:
-- ^[a-z0-9][a-z0-9_-]{0,63}$ (lowercase, 1..64 chars, starts alphanumeric).
-- Operation slug checks ensure every element has a non-empty text slug and
-- slugs are unique within the array, so INSERT cannot hit NOT NULL / PK errors.

CREATE TABLE IF NOT EXISTS user_openapi_bindings (
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	spec_url TEXT NOT NULL,
	api_base_url TEXT NOT NULL,
	description TEXT,
	auth_json TEXT NOT NULL,
	selection_json TEXT NOT NULL,
	include_destructive INTEGER NOT NULL DEFAULT 0 CHECK (include_destructive IN (0, 1)),
	spec_title TEXT,
	spec_version TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS user_openapi_binding_operations (
	user_id TEXT NOT NULL,
	binding_name TEXT NOT NULL,
	slug TEXT NOT NULL,
	operation_json TEXT NOT NULL,
	PRIMARY KEY (user_id, binding_name, slug),
	FOREIGN KEY (user_id, binding_name) REFERENCES user_openapi_bindings(user_id, name) ON DELETE CASCADE
);

-- Restart-safe staging: drop leftovers from a prior failed attempt, then recreate.
DROP TABLE IF EXISTS __migration_assertions;

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE IF NOT EXISTS __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

-- Abort if any user-scope `_openapi:*` row is not migratable (unknown data
-- must not be silently dropped). Compare counts rather than `NOT (predicate)`
-- so rows where the predicate is UNKNOWN (NULL) still count as non-migratable.
INSERT INTO __migration_assertions (message)
SELECT 'non-migratable _openapi:* value rows exist; aborting 0102.'
WHERE (
	SELECT count(*)
	FROM value_entries e
	INNER JOIN value_buckets b ON b.id = e.bucket_id AND b.scope = 'user'
	WHERE e.name LIKE '\_openapi:%' ESCAPE '\'
) != (
	SELECT count(*)
	FROM value_entries e
	INNER JOIN value_buckets b ON b.id = e.bucket_id AND b.scope = 'user'
	WHERE e.name LIKE '\_openapi:%' ESCAPE '\'
		AND length(substr(e.name, 10)) > 0
		AND length(substr(e.name, 10)) <= 64
		AND substr(e.name, 10) = trim(substr(e.name, 10))
		AND substr(e.name, 10) = lower(substr(e.name, 10))
		AND substr(e.name, 10) GLOB '[a-z0-9]*'
		AND substr(e.name, 10) NOT GLOB '*[^a-z0-9_-]*'
		AND json_valid(e.value)
		AND json_extract(e.value, '$.specUrl') IS NOT NULL
		AND trim(json_extract(e.value, '$.specUrl')) != ''
		AND json_extract(e.value, '$.apiBaseUrl') IS NOT NULL
		AND trim(json_extract(e.value, '$.apiBaseUrl')) != ''
		AND json_extract(e.value, '$.auth') IS NOT NULL
		AND json_extract(e.value, '$.selection') IS NOT NULL
		AND json_array_length(json_extract(e.value, '$.operations')) >= 1
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(e.value, '$.operations') AS op
			WHERE typeof(json_extract(op.value, '$.slug')) != 'text'
				OR trim(json_extract(op.value, '$.slug')) = ''
		)
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(e.value, '$.operations') AS op
			GROUP BY json_extract(op.value, '$.slug')
			HAVING count(*) > 1
		)
);

INSERT INTO user_openapi_bindings (
	user_id,
	name,
	spec_url,
	api_base_url,
	description,
	auth_json,
	selection_json,
	include_destructive,
	spec_title,
	spec_version,
	created_at,
	updated_at
)
SELECT
	b.user_id,
	substr(e.name, 10),
	trim(json_extract(e.value, '$.specUrl')),
	trim(json_extract(e.value, '$.apiBaseUrl')),
	NULLIF(trim(json_extract(e.value, '$.description')), ''),
	json_extract(e.value, '$.auth'),
	json_extract(e.value, '$.selection'),
	CASE
		WHEN json_extract(e.value, '$.includeDestructive') = 1 THEN 1
		ELSE 0
	END,
	NULLIF(trim(json_extract(e.value, '$.specTitle')), ''),
	NULLIF(trim(json_extract(e.value, '$.specVersion')), ''),
	e.created_at,
	COALESCE(
		NULLIF(trim(json_extract(e.value, '$.updatedAt')), ''),
		e.updated_at
	)
FROM value_entries e
INNER JOIN value_buckets b ON b.id = e.bucket_id AND b.scope = 'user'
WHERE e.name LIKE '\_openapi:%' ESCAPE '\'
	AND length(substr(e.name, 10)) > 0
	AND length(substr(e.name, 10)) <= 64
	AND substr(e.name, 10) = trim(substr(e.name, 10))
	AND substr(e.name, 10) = lower(substr(e.name, 10))
	AND substr(e.name, 10) GLOB '[a-z0-9]*'
	AND substr(e.name, 10) NOT GLOB '*[^a-z0-9_-]*'
	AND json_valid(e.value)
	AND json_extract(e.value, '$.specUrl') IS NOT NULL
	AND trim(json_extract(e.value, '$.specUrl')) != ''
	AND json_extract(e.value, '$.apiBaseUrl') IS NOT NULL
	AND trim(json_extract(e.value, '$.apiBaseUrl')) != ''
	AND json_extract(e.value, '$.auth') IS NOT NULL
	AND json_extract(e.value, '$.selection') IS NOT NULL
	AND json_array_length(json_extract(e.value, '$.operations')) >= 1
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(e.value, '$.operations') AS op
		WHERE typeof(json_extract(op.value, '$.slug')) != 'text'
			OR trim(json_extract(op.value, '$.slug')) = ''
	)
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(e.value, '$.operations') AS op
		GROUP BY json_extract(op.value, '$.slug')
		HAVING count(*) > 1
	);

INSERT INTO user_openapi_binding_operations (
	user_id,
	binding_name,
	slug,
	operation_json
)
SELECT
	b.user_id,
	substr(e.name, 10),
	json_extract(op.value, '$.slug'),
	op.value
FROM value_entries e
INNER JOIN value_buckets b ON b.id = e.bucket_id AND b.scope = 'user'
CROSS JOIN json_each(e.value, '$.operations') AS op
WHERE e.name LIKE '\_openapi:%' ESCAPE '\'
	AND length(substr(e.name, 10)) > 0
	AND length(substr(e.name, 10)) <= 64
	AND substr(e.name, 10) = trim(substr(e.name, 10))
	AND substr(e.name, 10) = lower(substr(e.name, 10))
	AND substr(e.name, 10) GLOB '[a-z0-9]*'
	AND substr(e.name, 10) NOT GLOB '*[^a-z0-9_-]*'
	AND json_valid(e.value)
	AND json_extract(e.value, '$.specUrl') IS NOT NULL
	AND trim(json_extract(e.value, '$.specUrl')) != ''
	AND json_extract(e.value, '$.apiBaseUrl') IS NOT NULL
	AND trim(json_extract(e.value, '$.apiBaseUrl')) != ''
	AND json_extract(e.value, '$.auth') IS NOT NULL
	AND json_extract(e.value, '$.selection') IS NOT NULL
	AND json_array_length(json_extract(e.value, '$.operations')) >= 1
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(e.value, '$.operations') AS bad
		WHERE typeof(json_extract(bad.value, '$.slug')) != 'text'
			OR trim(json_extract(bad.value, '$.slug')) = ''
	)
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(e.value, '$.operations') AS bad
		GROUP BY json_extract(bad.value, '$.slug')
		HAVING count(*) > 1
	);

-- Migrated binding count must equal migratable source count.
INSERT INTO __migration_assertions (message)
SELECT 'migratable _openapi:* row count does not match user_openapi_bindings; aborting 0102.'
WHERE (
	SELECT count(*)
	FROM value_entries e
	INNER JOIN value_buckets b ON b.id = e.bucket_id AND b.scope = 'user'
	WHERE e.name LIKE '\_openapi:%' ESCAPE '\'
		AND length(substr(e.name, 10)) > 0
		AND length(substr(e.name, 10)) <= 64
		AND substr(e.name, 10) = trim(substr(e.name, 10))
		AND substr(e.name, 10) = lower(substr(e.name, 10))
		AND substr(e.name, 10) GLOB '[a-z0-9]*'
		AND substr(e.name, 10) NOT GLOB '*[^a-z0-9_-]*'
		AND json_valid(e.value)
		AND json_extract(e.value, '$.specUrl') IS NOT NULL
		AND trim(json_extract(e.value, '$.specUrl')) != ''
		AND json_extract(e.value, '$.apiBaseUrl') IS NOT NULL
		AND trim(json_extract(e.value, '$.apiBaseUrl')) != ''
		AND json_extract(e.value, '$.auth') IS NOT NULL
		AND json_extract(e.value, '$.selection') IS NOT NULL
		AND json_array_length(json_extract(e.value, '$.operations')) >= 1
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(e.value, '$.operations') AS op
			WHERE typeof(json_extract(op.value, '$.slug')) != 'text'
				OR trim(json_extract(op.value, '$.slug')) = ''
		)
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(e.value, '$.operations') AS op
			GROUP BY json_extract(op.value, '$.slug')
			HAVING count(*) > 1
		)
) != (SELECT count(*) FROM user_openapi_bindings);

-- Operation row count must equal the summed operations array lengths.
INSERT INTO __migration_assertions (message)
SELECT 'migrated operation row count does not match source $.operations lengths; aborting 0102.'
WHERE (
	SELECT count(*) FROM user_openapi_binding_operations
) != (
	SELECT COALESCE(SUM(json_array_length(json_extract(e.value, '$.operations'))), 0)
	FROM value_entries e
	INNER JOIN value_buckets b ON b.id = e.bucket_id AND b.scope = 'user'
	WHERE e.name LIKE '\_openapi:%' ESCAPE '\'
		AND length(substr(e.name, 10)) > 0
		AND length(substr(e.name, 10)) <= 64
		AND substr(e.name, 10) = trim(substr(e.name, 10))
		AND substr(e.name, 10) = lower(substr(e.name, 10))
		AND substr(e.name, 10) GLOB '[a-z0-9]*'
		AND substr(e.name, 10) NOT GLOB '*[^a-z0-9_-]*'
		AND json_valid(e.value)
		AND json_extract(e.value, '$.specUrl') IS NOT NULL
		AND trim(json_extract(e.value, '$.specUrl')) != ''
		AND json_extract(e.value, '$.apiBaseUrl') IS NOT NULL
		AND trim(json_extract(e.value, '$.apiBaseUrl')) != ''
		AND json_extract(e.value, '$.auth') IS NOT NULL
		AND json_extract(e.value, '$.selection') IS NOT NULL
		AND json_array_length(json_extract(e.value, '$.operations')) >= 1
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(e.value, '$.operations') AS op
			WHERE typeof(json_extract(op.value, '$.slug')) != 'text'
				OR trim(json_extract(op.value, '$.slug')) = ''
		)
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(e.value, '$.operations') AS op
			GROUP BY json_extract(op.value, '$.slug')
			HAVING count(*) > 1
		)
);

DELETE FROM value_entries
WHERE EXISTS (
	SELECT 1
	FROM value_buckets b
	WHERE b.id = value_entries.bucket_id
		AND b.scope = 'user'
		AND value_entries.name LIKE '\_openapi:%' ESCAPE '\'
);

-- No `_openapi:*` rows may remain after backfill.
INSERT INTO __migration_assertions (message)
SELECT '_openapi:* value rows remain after backfill; aborting 0102.'
WHERE EXISTS (
	SELECT 1
	FROM value_entries e
	INNER JOIN value_buckets b ON b.id = e.bucket_id AND b.scope = 'user'
	WHERE e.name LIKE '\_openapi:%' ESCAPE '\'
);

DROP TABLE IF EXISTS __migration_assertions;
