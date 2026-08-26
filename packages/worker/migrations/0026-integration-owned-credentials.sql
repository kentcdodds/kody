-- OAuth access/refresh tokens and user-lane client secrets move onto the
-- integration/app rows (encrypted at rest). usage_mode + allowed_packages_json
-- are the user-gated grant: 'any' is execute plus every package; 'packages'
-- is only the listed saved package ids. New connections default to 'any'.
-- *_secret_name columns stay for dual-write soak and placeholder resolution.
ALTER TABLE user_integrations ADD COLUMN access_token_encrypted TEXT;

ALTER TABLE user_integrations ADD COLUMN refresh_token_encrypted TEXT;

ALTER TABLE user_integrations ADD COLUMN usage_mode TEXT NOT NULL DEFAULT 'any'
	CHECK (usage_mode IN ('any', 'packages'));

ALTER TABLE user_integrations ADD COLUMN allowed_packages_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE user_oauth_apps ADD COLUMN client_secret_encrypted TEXT;
