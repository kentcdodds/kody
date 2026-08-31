-- Operator-owned brand marks for saved integrations. Display falls back to
-- these after an explicit upload and auto-favicon miss, matched by slug,
-- family prefix, or alias (provider key or authorize host). Assets live in
-- COMMUNITY_ASSETS under content-hashed platform-provider-marks/{slug}/ keys.
CREATE TABLE platform_provider_marks (
	slug TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	aliases_json TEXT NOT NULL DEFAULT '[]',
	logo_key TEXT,
	logo_content_type TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
