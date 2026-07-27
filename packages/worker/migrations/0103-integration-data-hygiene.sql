-- Integration data hygiene after the 0101 OAuth apps/connections backfill.
--
-- Three cleanup steps for leftover production residue that 0101 deliberately
-- left alone or that the connect flow wrote incorrectly:
--
-- 1. Delete abandoned `_integration:*` value rows. Migration 0101 only removed
--    migratable connection blobs; incomplete connect-flow attempts survived as
--    hidden values. Production had a handful across a couple of users, none of
--    which ever completed a token exchange.
-- 2. Clear orphaned `refresh_token_secret_name` pointers. The connect flow used
--    to persist a refresh-token secret name even when the provider returned no
--    refresh token and no such secret was written, so later 401 refresh paths
--    failed with a confusing missing-secret error.
-- 3. Normalize URL-shaped entries in `required_hosts_json` down to bare hosts
--    (strip `http://` / `https://` and any path), matching
--    `normalizeAllowedHosts` host canonicalization: trim, lowercase, dedupe,
--    sort.
--
-- Restart-safe: each statement is idempotent; assertions abort the migration
-- transaction when invariants fail.

DROP TABLE IF EXISTS __migration_assertions;

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE IF NOT EXISTS __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

-- 1. Delete leftover `_integration:*` value rows (any scope).
DELETE FROM value_entries
WHERE name LIKE '\_integration:%' ESCAPE '\';

INSERT INTO __migration_assertions (message)
SELECT '_integration:* value rows remain after hygiene; aborting 0103.'
WHERE EXISTS (
	SELECT 1
	FROM value_entries
	WHERE name LIKE '\_integration:%' ESCAPE '\'
);

-- 2. Clear orphaned refresh-token secret name references.
UPDATE user_integrations
SET refresh_token_secret_name = NULL
WHERE refresh_token_secret_name IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM secret_entries se
		INNER JOIN secret_buckets sb ON sb.id = se.bucket_id
		WHERE sb.user_id = user_integrations.user_id
			AND sb.scope = 'user'
			AND se.name = user_integrations.refresh_token_secret_name
	);

INSERT INTO __migration_assertions (message)
SELECT 'orphaned refresh_token_secret_name references remain; aborting 0103.'
WHERE EXISTS (
	SELECT 1
	FROM user_integrations ui
	WHERE ui.refresh_token_secret_name IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM secret_entries se
			INNER JOIN secret_buckets sb ON sb.id = se.bucket_id
			WHERE sb.user_id = ui.user_id
				AND sb.scope = 'user'
				AND se.name = ui.refresh_token_secret_name
		)
);

-- 3. Normalize URL-shaped required hosts to bare hosts.
UPDATE user_integrations
SET required_hosts_json = COALESCE(
	(
		SELECT json_group_array(host)
		FROM (
			SELECT host
			FROM (
				SELECT
					CASE
						WHEN lower(trim(value)) LIKE 'https://%' THEN
							lower(
								CASE
									WHEN instr(substr(trim(value), 9), '/') > 0 THEN
										substr(
											substr(trim(value), 9),
											1,
											instr(substr(trim(value), 9), '/') - 1
										)
									ELSE substr(trim(value), 9)
								END
							)
						WHEN lower(trim(value)) LIKE 'http://%' THEN
							lower(
								CASE
									WHEN instr(substr(trim(value), 8), '/') > 0 THEN
										substr(
											substr(trim(value), 8),
											1,
											instr(substr(trim(value), 8), '/') - 1
										)
									ELSE substr(trim(value), 8)
								END
							)
						ELSE lower(trim(value))
					END AS host
				FROM json_each(user_integrations.required_hosts_json)
				WHERE typeof(value) = 'text' AND trim(value) != ''
			)
			WHERE host != ''
			GROUP BY host
			ORDER BY host
		)
	),
	'[]'
)
WHERE required_hosts_json LIKE '%"http://%'
	OR required_hosts_json LIKE '%"https://%';

INSERT INTO __migration_assertions (message)
SELECT 'URL-shaped required hosts remain after hygiene; aborting 0103.'
WHERE EXISTS (
	SELECT 1
	FROM user_integrations
	WHERE required_hosts_json LIKE '%"http://%'
		OR required_hosts_json LIKE '%"https://%'
);

DROP TABLE IF EXISTS __migration_assertions;
