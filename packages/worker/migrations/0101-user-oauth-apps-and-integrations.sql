-- First-class OAuth apps + connections, replacing `_integration:*` value blobs.
--
-- An OAuth app (client credentials + provider endpoints) is distinct from a
-- connection (one connected account). Production has connections that share an
-- app (e.g. four Google connections, one client id + client secret) and pairs
-- that look similar but must stay separate apps when client secrets differ
-- (github vs github-kent).
--
-- Composite primary/foreign keys keep per-user isolation structural: a bare
-- UUID app_id FK could theoretically point across users; (user_id, slug) cannot.
-- Tokens and client secrets stay in secret_entries, referenced by name only.
--
-- Backfill reads user-scoped `_integration:*` values, resolves client_id from
-- the sibling value named by `$.clientIdValueName`, and dedupes apps by the
-- full app-level tuple (credentials + endpoints + flow options). Connections
-- merge into one app only when they agree on every app-level field; any
-- disagreement yields separate apps so no config is silently rewritten.
--
-- Slug collision cannot occur: app slug is min(connection_name) per group, each
-- connection belongs to exactly one group, and connection names are already
-- unique per user. value_buckets has UNIQUE(user_id, scope, binding_key) and
-- user-scope rows always use binding_key = '', so there is exactly one
-- user-scope bucket per user; value_entries is keyed (bucket_id, name).
-- Therefore (user_id, name) is unique for user-scope `_integration:*` rows.
--
-- Then deletes only the migrated integration value rows. Client-id values and
-- any non-migratable `_integration:*` rows are left untouched.
--
-- Migratable name/value predicate (must stay identical across capture INSERT,
-- DELETE, and post-delete assertion — only the entry alias differs):
--   <entry>.name LIKE '\_integration:%' ESCAPE '\'
--   AND length(substr(<entry>.name, 14)) > 0
--   AND substr(<entry>.name, 14) = trim(substr(<entry>.name, 14))
--   AND substr(<entry>.name, 14) = lower(substr(<entry>.name, 14))
--   AND substr(<entry>.name, 14) NOT LIKE '-%'
--   AND substr(<entry>.name, 14) NOT LIKE '%-'
--   AND substr(<entry>.name, 14) NOT GLOB '*[^a-z0-9._-]*'
--   AND substr(<entry>.name, 14) GLOB '*[a-z0-9]*'
--   AND json_valid(<entry>.value)
--   AND json_extract(<entry>.value, '$.tokenUrl') IS NOT NULL
--   AND trim(json_extract(<entry>.value, '$.tokenUrl')) != ''
--   AND json_extract(<entry>.value, '$.accessTokenSecretName') IS NOT NULL
--   AND trim(json_extract(<entry>.value, '$.accessTokenSecretName')) != ''
--   AND json_extract(<entry>.value, '$.flow') IN ('pkce', 'confidential')
--   AND trim(cid.value) != ''
--   AND (
--     json_extract(<entry>.value, '$.tokenExchangeStyle') IS NULL
--     OR json_extract(<entry>.value, '$.tokenExchangeStyle') IN (
--       'form', 'basic-json', 'basic-form'
--     )
--   )
-- The name checks mirror parseIntegrationValueName / normalizeProviderKey:
-- non-empty canonical lowercase kebab (no leading/trailing '-', only
-- [a-z0-9._-], at least one alphanumeric). Empty `_integration:` and
-- non-canonical suffixes survive as values.

CREATE TABLE IF NOT EXISTS user_oauth_apps (
	user_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	provider TEXT NOT NULL,
	label TEXT,
	client_id TEXT NOT NULL,
	client_secret_secret_name TEXT,
	token_url TEXT NOT NULL,
	authorize_url TEXT,
	api_base_url TEXT,
	flow TEXT NOT NULL CHECK (flow IN ('pkce', 'confidential')),
	use_pkce INTEGER CHECK (use_pkce IN (0, 1)),
	token_exchange_style TEXT CHECK (token_exchange_style IN ('form', 'basic-json', 'basic-form')),
	scope_separator TEXT,
	extra_authorize_params_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	PRIMARY KEY (user_id, slug)
);

CREATE TABLE IF NOT EXISTS user_integrations (
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	app_slug TEXT NOT NULL,
	account_label TEXT,
	description TEXT NOT NULL DEFAULT '',
	scopes_json TEXT NOT NULL DEFAULT '[]',
	required_hosts_json TEXT NOT NULL DEFAULT '[]',
	access_token_secret_name TEXT NOT NULL,
	refresh_token_secret_name TEXT,
	connected_at TEXT,
	token_refreshed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	PRIMARY KEY (user_id, name),
	FOREIGN KEY (user_id, app_slug) REFERENCES user_oauth_apps(user_id, slug) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_user_integrations_user_app_slug
ON user_integrations(user_id, app_slug);

CREATE INDEX IF NOT EXISTS idx_user_oauth_apps_user_provider
ON user_oauth_apps(user_id, provider);

-- Restart-safe staging: drop leftovers from a prior failed attempt, then recreate.
DROP TABLE IF EXISTS __migration_0100_source;
DROP TABLE IF EXISTS __migration_0100_app_groups;
DROP TABLE IF EXISTS __migration_assertions;

-- Staging table so app insert + connection insert share one grouping definition.
CREATE TABLE IF NOT EXISTS __migration_0100_source (
	user_id TEXT NOT NULL,
	connection_name TEXT NOT NULL,
	description TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	client_id TEXT NOT NULL,
	client_secret_secret_name TEXT,
	token_url TEXT NOT NULL,
	authorize_url TEXT,
	api_base_url TEXT,
	flow TEXT NOT NULL,
	use_pkce INTEGER,
	token_exchange_style TEXT,
	scope_separator TEXT,
	extra_authorize_params_json TEXT NOT NULL,
	scopes_json TEXT NOT NULL,
	required_hosts_json TEXT NOT NULL,
	access_token_secret_name TEXT NOT NULL,
	refresh_token_secret_name TEXT
);

INSERT INTO __migration_0100_source (
	user_id,
	connection_name,
	description,
	created_at,
	updated_at,
	client_id,
	client_secret_secret_name,
	token_url,
	authorize_url,
	api_base_url,
	flow,
	use_pkce,
	token_exchange_style,
	scope_separator,
	extra_authorize_params_json,
	scopes_json,
	required_hosts_json,
	access_token_secret_name,
	refresh_token_secret_name
)
SELECT
	b.user_id,
	substr(e.name, 14),
	COALESCE(e.description, ''),
	e.created_at,
	e.updated_at,
	trim(cid.value),
	-- Match buildOauthAppRow: client secrets are confidential-only. pkce rows
	-- must store NULL so findOauthAppByAppTuple matches application upserts.
	CASE
		WHEN json_extract(e.value, '$.flow') = 'confidential'
		THEN NULLIF(trim(json_extract(e.value, '$.clientSecretSecretName')), '')
		ELSE NULL
	END,
	trim(json_extract(e.value, '$.tokenUrl')),
	NULLIF(trim(json_extract(e.value, '$.authorization.authorizeUrl')), ''),
	NULLIF(trim(json_extract(e.value, '$.apiBaseUrl')), ''),
	json_extract(e.value, '$.flow'),
	-- Match normalizeIntegrationConfig: store usePkce only when it differs
	-- from the flow default (pkce→on, confidential→off). Otherwise NULL so
	-- findOauthAppByAppTuple matches application-layer upserts.
	CASE
		WHEN json_extract(e.value, '$.usePkce') IS NULL THEN NULL
		WHEN json_extract(e.value, '$.usePkce') = (
			json_extract(e.value, '$.flow') = 'pkce'
		) THEN NULL
		WHEN json_extract(e.value, '$.usePkce') = 0 THEN 0
		ELSE 1
	END,
	-- Match buildOauthAppRow: 'form' is the default exchange style → NULL.
	CASE
		WHEN json_extract(e.value, '$.tokenExchangeStyle') IS NULL THEN NULL
		WHEN json_extract(e.value, '$.tokenExchangeStyle') = 'form' THEN NULL
		ELSE json_extract(e.value, '$.tokenExchangeStyle')
	END,
	-- Match normalizeIntegrationAuthorization: default scope separator (' ')
	-- is stored as NULL.
	CASE
		WHEN json_extract(e.value, '$.authorization.scopeSeparator') IS NULL
		THEN NULL
		WHEN json_extract(e.value, '$.authorization.scopeSeparator') = ' '
		THEN NULL
		ELSE json_extract(e.value, '$.authorization.scopeSeparator')
	END,
	-- Match normalizeIntegrationAuthorization: rebuild with sorted keys so the
	-- stored JSON is byte-identical to JSON.stringify of the sorted object.
	-- ORDER BY key uses SQLite BINARY collation; the app sorts with
	-- localeCompare. They agree for the lowercase snake_case OAuth param keys
	-- providers use; mixed-case keys could diverge.
	-- Missing authorization / missing extraAuthorizeParams / explicit {} all
	-- yield '{}' (json_group_object over zero rows returns '{}', not NULL).
	COALESCE(
		(
			SELECT json_group_object(key, value)
			FROM (
				SELECT trim(key) AS key, value
				FROM json_each(
					COALESCE(
						json_extract(
							e.value,
							'$.authorization.extraAuthorizeParams'
						),
						'{}'
					)
				)
				WHERE typeof(key) = 'text' AND trim(key) != ''
				ORDER BY key
			)
		),
		'{}'
	),
	-- Match normalizeIntegrationAuthorization scopes: trim, drop empties,
	-- preserve encounter order (not sorted).
	COALESCE(
		(
			SELECT json_group_array(scope)
			FROM (
				SELECT trim(value) AS scope
				FROM json_each(
					COALESCE(
						json_extract(e.value, '$.authorization.scopes'),
						'[]'
					)
				)
				WHERE typeof(value) = 'text' AND trim(value) != ''
			)
		),
		'[]'
	),
	-- Match normalizeAllowedHosts: trim, lowercase, dedupe, sort.
	COALESCE(
		(
			SELECT json_group_array(host)
			FROM (
				SELECT lower(trim(value)) AS host
				FROM json_each(
					COALESCE(json_extract(e.value, '$.requiredHosts'), '[]')
				)
				WHERE typeof(value) = 'text' AND trim(value) != ''
				GROUP BY host
				ORDER BY host
			)
		),
		'[]'
	),
	trim(json_extract(e.value, '$.accessTokenSecretName')),
	NULLIF(trim(json_extract(e.value, '$.refreshTokenSecretName')), '')
FROM value_entries e
INNER JOIN value_buckets b ON b.id = e.bucket_id
INNER JOIN value_entries cid
	ON cid.bucket_id = e.bucket_id
	AND cid.name = json_extract(e.value, '$.clientIdValueName')
WHERE b.scope = 'user'
	AND e.name LIKE '\_integration:%' ESCAPE '\'
	AND length(substr(e.name, 14)) > 0
	AND substr(e.name, 14) = trim(substr(e.name, 14))
	AND substr(e.name, 14) = lower(substr(e.name, 14))
	AND substr(e.name, 14) NOT LIKE '-%'
	AND substr(e.name, 14) NOT LIKE '%-'
	AND substr(e.name, 14) NOT GLOB '*[^a-z0-9._-]*'
	AND substr(e.name, 14) GLOB '*[a-z0-9]*'
	AND json_valid(e.value)
	AND json_extract(e.value, '$.tokenUrl') IS NOT NULL
	AND trim(json_extract(e.value, '$.tokenUrl')) != ''
	AND json_extract(e.value, '$.accessTokenSecretName') IS NOT NULL
	AND trim(json_extract(e.value, '$.accessTokenSecretName')) != ''
	AND json_extract(e.value, '$.flow') IN ('pkce', 'confidential')
	AND trim(cid.value) != ''
	AND (
		json_extract(e.value, '$.tokenExchangeStyle') IS NULL
		OR json_extract(e.value, '$.tokenExchangeStyle') IN (
			'form',
			'basic-json',
			'basic-form'
		)
	);

CREATE TABLE IF NOT EXISTS __migration_0100_app_groups (
	user_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	client_id TEXT NOT NULL,
	client_secret_secret_name TEXT,
	token_url TEXT NOT NULL,
	authorize_url TEXT,
	api_base_url TEXT,
	flow TEXT NOT NULL,
	use_pkce INTEGER,
	token_exchange_style TEXT,
	scope_separator TEXT,
	extra_authorize_params_json TEXT NOT NULL,
	PRIMARY KEY (user_id, slug)
);

INSERT INTO __migration_0100_app_groups (
	user_id,
	slug,
	client_id,
	client_secret_secret_name,
	token_url,
	authorize_url,
	api_base_url,
	flow,
	use_pkce,
	token_exchange_style,
	scope_separator,
	extra_authorize_params_json
)
SELECT
	user_id,
	min(connection_name) AS slug,
	client_id,
	client_secret_secret_name,
	token_url,
	authorize_url,
	api_base_url,
	flow,
	use_pkce,
	token_exchange_style,
	scope_separator,
	extra_authorize_params_json
FROM __migration_0100_source
GROUP BY
	user_id,
	client_id,
	client_secret_secret_name,
	token_url,
	authorize_url,
	api_base_url,
	flow,
	use_pkce,
	token_exchange_style,
	scope_separator,
	extra_authorize_params_json;

INSERT INTO user_oauth_apps (
	user_id,
	slug,
	provider,
	label,
	client_id,
	client_secret_secret_name,
	token_url,
	authorize_url,
	api_base_url,
	flow,
	use_pkce,
	token_exchange_style,
	scope_separator,
	extra_authorize_params_json,
	created_at,
	updated_at
)
SELECT
	g.user_id,
	g.slug,
	CASE
		WHEN instr(g.slug, '-') > 0 THEN substr(g.slug, 1, instr(g.slug, '-') - 1)
		ELSE g.slug
	END AS provider,
	NULL AS label,
	g.client_id,
	g.client_secret_secret_name,
	g.token_url,
	g.authorize_url,
	g.api_base_url,
	g.flow,
	g.use_pkce,
	g.token_exchange_style,
	g.scope_separator,
	g.extra_authorize_params_json,
	s.created_at,
	s.updated_at
FROM __migration_0100_app_groups g
INNER JOIN __migration_0100_source s
	ON s.user_id = g.user_id
	AND s.connection_name = g.slug;

INSERT INTO user_integrations (
	user_id,
	name,
	app_slug,
	account_label,
	description,
	scopes_json,
	required_hosts_json,
	access_token_secret_name,
	refresh_token_secret_name,
	connected_at,
	token_refreshed_at,
	created_at,
	updated_at
)
SELECT
	s.user_id,
	s.connection_name AS name,
	g.slug AS app_slug,
	NULL AS account_label,
	s.description,
	s.scopes_json,
	s.required_hosts_json,
	s.access_token_secret_name,
	s.refresh_token_secret_name,
	NULL AS connected_at,
	NULL AS token_refreshed_at,
	s.created_at,
	s.updated_at
FROM __migration_0100_source s
INNER JOIN __migration_0100_app_groups g
	ON s.user_id = g.user_id
	AND s.client_id IS g.client_id
	AND s.client_secret_secret_name IS g.client_secret_secret_name
	AND s.token_url IS g.token_url
	AND s.authorize_url IS g.authorize_url
	AND s.api_base_url IS g.api_base_url
	AND s.flow IS g.flow
	AND s.use_pkce IS g.use_pkce
	AND s.token_exchange_style IS g.token_exchange_style
	AND s.scope_separator IS g.scope_separator
	AND s.extra_authorize_params_json IS g.extra_authorize_params_json;

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE IF NOT EXISTS __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

-- Every migratable `_integration:*` row must produce exactly one connection
-- (asserted before those value rows are deleted).
INSERT INTO __migration_assertions (message)
SELECT 'migratable _integration:* row count does not match user_integrations; aborting 0100.'
WHERE (
	SELECT count(*) FROM __migration_0100_source
) != (SELECT count(*) FROM user_integrations);

INSERT INTO __migration_assertions (message)
SELECT 'migratable _integration:* row missing user_integrations connection; aborting 0100.'
WHERE EXISTS (
	SELECT 1
	FROM __migration_0100_source s
	WHERE NOT EXISTS (
		SELECT 1
		FROM user_integrations i
		WHERE i.user_id = s.user_id
			AND i.name = s.connection_name
	)
);

-- Every connection must resolve to an app in the same user scope.
INSERT INTO __migration_assertions (message)
SELECT 'user_integrations row missing resolvable user_oauth_apps parent; aborting 0100.'
WHERE EXISTS (
	SELECT 1
	FROM user_integrations i
	WHERE NOT EXISTS (
		SELECT 1
		FROM user_oauth_apps a
		WHERE a.user_id = i.user_id AND a.slug = i.app_slug
	)
);

INSERT INTO __migration_assertions (message)
SELECT 'user_integrations.access_token_secret_name is NULL; aborting 0100.'
WHERE EXISTS (
	SELECT 1
	FROM user_integrations
	WHERE access_token_secret_name IS NULL
		OR trim(access_token_secret_name) = ''
);

DELETE FROM value_entries
WHERE EXISTS (
	SELECT 1
	FROM value_buckets b
	INNER JOIN value_entries cid
		ON cid.bucket_id = value_entries.bucket_id
		AND cid.name = json_extract(value_entries.value, '$.clientIdValueName')
	WHERE b.id = value_entries.bucket_id
		AND b.scope = 'user'
		AND value_entries.name LIKE '\_integration:%' ESCAPE '\'
		AND length(substr(value_entries.name, 14)) > 0
		AND substr(value_entries.name, 14) = trim(substr(value_entries.name, 14))
		AND substr(value_entries.name, 14) = lower(substr(value_entries.name, 14))
		AND substr(value_entries.name, 14) NOT LIKE '-%'
		AND substr(value_entries.name, 14) NOT LIKE '%-'
		AND substr(value_entries.name, 14) NOT GLOB '*[^a-z0-9._-]*'
		AND substr(value_entries.name, 14) GLOB '*[a-z0-9]*'
		AND json_valid(value_entries.value)
		AND json_extract(value_entries.value, '$.tokenUrl') IS NOT NULL
		AND trim(json_extract(value_entries.value, '$.tokenUrl')) != ''
		AND json_extract(value_entries.value, '$.accessTokenSecretName') IS NOT NULL
		AND trim(json_extract(value_entries.value, '$.accessTokenSecretName')) != ''
		AND json_extract(value_entries.value, '$.flow') IN ('pkce', 'confidential')
		AND trim(cid.value) != ''
		AND (
			json_extract(value_entries.value, '$.tokenExchangeStyle') IS NULL
			OR json_extract(value_entries.value, '$.tokenExchangeStyle') IN (
				'form',
				'basic-json',
				'basic-form'
			)
		)
);

-- No migratable `_integration:*` rows may remain (malformed non-migratable rows may).
INSERT INTO __migration_assertions (message)
SELECT 'migratable _integration:* value rows remain after backfill; aborting 0100.'
WHERE EXISTS (
	SELECT 1
	FROM value_entries e
	INNER JOIN value_buckets b ON b.id = e.bucket_id
	INNER JOIN value_entries cid
		ON cid.bucket_id = e.bucket_id
		AND cid.name = json_extract(e.value, '$.clientIdValueName')
	WHERE b.scope = 'user'
		AND e.name LIKE '\_integration:%' ESCAPE '\'
		AND length(substr(e.name, 14)) > 0
		AND substr(e.name, 14) = trim(substr(e.name, 14))
		AND substr(e.name, 14) = lower(substr(e.name, 14))
		AND substr(e.name, 14) NOT LIKE '-%'
		AND substr(e.name, 14) NOT LIKE '%-'
		AND substr(e.name, 14) NOT GLOB '*[^a-z0-9._-]*'
		AND substr(e.name, 14) GLOB '*[a-z0-9]*'
		AND json_valid(e.value)
		AND json_extract(e.value, '$.tokenUrl') IS NOT NULL
		AND trim(json_extract(e.value, '$.tokenUrl')) != ''
		AND json_extract(e.value, '$.accessTokenSecretName') IS NOT NULL
		AND trim(json_extract(e.value, '$.accessTokenSecretName')) != ''
		AND json_extract(e.value, '$.flow') IN ('pkce', 'confidential')
		AND trim(cid.value) != ''
		AND (
			json_extract(e.value, '$.tokenExchangeStyle') IS NULL
			OR json_extract(e.value, '$.tokenExchangeStyle') IN (
				'form',
				'basic-json',
				'basic-form'
			)
		)
);

DROP TABLE IF EXISTS __migration_assertions;
DROP TABLE IF EXISTS __migration_0100_app_groups;
DROP TABLE IF EXISTS __migration_0100_source;
