-- Credentials plan v4 (ADR 0068): every credential row records its provider,
-- how its value is placed on a request (`inject`), and where the value comes
-- from (`source`). Nothing reads these yet; the gateway keeps filling
-- placeholders exactly as before.
--
-- inject_json is one of:
--   {"kind":"header","name":"<header>","format":"<text with {value}>"}
--   {"kind":"basic","valueAs":"username"|"password","other":"<literal>"}
--   {"kind":"query","param":"<name>"}
-- and defaults to `Authorization: Bearer {value}`. It never places a value in
-- a body.
--
-- source_json is "stored" (the value lives in Kody) or {"vault":"<provider>"}
-- for a vault binding, whose ref still comes from each placeholder.
--
-- An OAuth integration's provider is its OAuth app's provider. A row whose app
-- row is missing keeps a NULL provider rather than blocking the deploy.

ALTER TABLE secret_entries ADD COLUMN provider TEXT;
ALTER TABLE secret_entries ADD COLUMN inject_json TEXT NOT NULL
	DEFAULT '{"kind":"header","name":"Authorization","format":"Bearer {value}"}'
	CHECK (json_valid(inject_json));
ALTER TABLE secret_entries ADD COLUMN source_json TEXT NOT NULL
	DEFAULT '"stored"' CHECK (json_valid(source_json));

ALTER TABLE user_integrations ADD COLUMN provider TEXT;
ALTER TABLE user_integrations ADD COLUMN inject_json TEXT NOT NULL
	DEFAULT '{"kind":"header","name":"Authorization","format":"Bearer {value}"}'
	CHECK (json_valid(inject_json));
ALTER TABLE user_integrations ADD COLUMN source_json TEXT NOT NULL
	DEFAULT '"stored"' CHECK (json_valid(source_json));

ALTER TABLE mcp_server_settings ADD COLUMN provider TEXT;
ALTER TABLE mcp_server_settings ADD COLUMN inject_json TEXT NOT NULL
	DEFAULT '{"kind":"header","name":"Authorization","format":"Bearer {value}"}'
	CHECK (json_valid(inject_json));
ALTER TABLE mcp_server_settings ADD COLUMN source_json TEXT NOT NULL
	DEFAULT '"stored"' CHECK (json_valid(source_json));

ALTER TABLE secret_provider_bindings ADD COLUMN provider TEXT;
ALTER TABLE secret_provider_bindings ADD COLUMN inject_json TEXT NOT NULL
	DEFAULT '{"kind":"header","name":"Authorization","format":"Bearer {value}"}'
	CHECK (json_valid(inject_json));
ALTER TABLE secret_provider_bindings ADD COLUMN source_json TEXT NOT NULL
	DEFAULT '"stored"' CHECK (json_valid(source_json));

UPDATE secret_provider_bindings
SET source_json = json_object('vault', provider_id);

-- Soft-deleted rows are backfilled too: they keep their id and may be restored.
UPDATE user_integrations
SET provider = COALESCE(
	(
		SELECT p.provider FROM platform_oauth_apps p
		WHERE p.slug = user_integrations.platform_app_slug
	),
	(
		SELECT a.provider FROM user_oauth_apps a
		WHERE a.user_id = user_integrations.user_id
			AND a.slug = user_integrations.app_slug
	)
);
