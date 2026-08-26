-- User-lane OAuth app logos: explicit upload or auto-fetched favicon.
-- Assets live in COMMUNITY_ASSETS under content-hashed keys. SVG is
-- rasterized; ICO is accepted only when it embeds a PNG (classic BMP
-- ICO is skipped). logo_source distinguishes an explicit upload (beats
-- the catalog SVG) from an auto-favicon (loses to the catalog).
-- favicon_source_host records the registrable domain last used so a
-- changed authorize URL can re-fetch.
ALTER TABLE user_oauth_apps ADD COLUMN logo_key TEXT;

ALTER TABLE user_oauth_apps ADD COLUMN logo_content_type TEXT;

ALTER TABLE user_oauth_apps ADD COLUMN logo_source TEXT
	CHECK (logo_source IN ('upload', 'favicon'));

ALTER TABLE user_oauth_apps ADD COLUMN favicon_source_host TEXT;
