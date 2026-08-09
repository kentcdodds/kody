-- Platform (built-in) OAuth apps: operator-provisioned provider registrations
-- shared by every user. The client secret is stored encrypted (AES-GCM keyed
-- off SECRET_STORE_KEY with a dedicated purpose) and is intentionally outside
-- the user secret store, so it never enters the {{secret:...}} placeholder
-- namespace that sandboxed code can reference.
CREATE TABLE platform_oauth_apps (
	-- SQLite quirk: plain TEXT PRIMARY KEY still allows NULL; be explicit.
	slug TEXT PRIMARY KEY NOT NULL,
	provider TEXT NOT NULL,
	label TEXT,
	client_id TEXT NOT NULL,
	client_secret_encrypted TEXT,
	token_url TEXT NOT NULL,
	authorize_url TEXT NOT NULL,
	api_base_url TEXT,
	flow TEXT NOT NULL CHECK (flow IN ('pkce', 'confidential')),
	use_pkce INTEGER CHECK (use_pkce IN (0, 1)),
	token_exchange_style TEXT CHECK (token_exchange_style IN ('form', 'basic-json', 'basic-form')),
	scope_separator TEXT,
	extra_authorize_params_json TEXT NOT NULL DEFAULT '{}',
	-- Scope menu: the verified superset an operator may ever request...
	allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
	-- ...and the minimal set the connect flow requests by default.
	default_scopes_json TEXT NOT NULL DEFAULT '[]',
	required_hosts_json TEXT NOT NULL DEFAULT '[]',
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Rebuild user_integrations so a connection can reference either a user-owned
-- OAuth app (app_slug) or a platform app (platform_app_slug), exactly one of
-- the two. SQLite skips composite-FK enforcement when a component is NULL, so
-- built-in connections do not trip the user_oauth_apps FK.
CREATE TABLE user_integrations_next (
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	app_slug TEXT,
	platform_app_slug TEXT REFERENCES platform_oauth_apps(slug) ON DELETE RESTRICT,
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
	FOREIGN KEY (user_id, app_slug) REFERENCES user_oauth_apps(user_id, slug) ON DELETE RESTRICT,
	CHECK ((app_slug IS NULL) <> (platform_app_slug IS NULL))
);

INSERT INTO user_integrations_next (
	user_id,
	name,
	app_slug,
	platform_app_slug,
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
	user_id,
	name,
	app_slug,
	NULL,
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
FROM user_integrations;

DROP TABLE user_integrations;

ALTER TABLE user_integrations_next RENAME TO user_integrations;

-- Recreate the 0001 index dropped with the old table, then index the new
-- platform lane.
CREATE INDEX idx_user_integrations_user_app_slug
ON user_integrations(user_id, app_slug);

CREATE INDEX idx_user_integrations_platform_app
ON user_integrations(platform_app_slug)
WHERE platform_app_slug IS NOT NULL;
