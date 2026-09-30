-- Catalog visibility for platform (built-in) OAuth apps. `enabled` stays the
-- hard kill for connect; `visibility` only decides whether an enabled app is
-- offered on discovery surfaces (onboarding, account integrations, the
-- /connect/oauth chooser) and accepts new connects from them. Existing rows
-- default to draft so nothing new surfaces; draft apps keep serving the
-- connections users already have.
ALTER TABLE platform_oauth_apps ADD COLUMN visibility TEXT NOT NULL DEFAULT 'draft'
	CHECK (visibility IN ('draft', 'published'));
