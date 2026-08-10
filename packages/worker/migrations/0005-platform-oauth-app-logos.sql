-- Operator-uploaded provider logos for platform (built-in) OAuth apps. The
-- asset lives in the COMMUNITY_ASSETS R2 bucket under a content-hashed key;
-- these columns hold the key and the processed content type. SVG uploads are
-- rasterized to PNG before storage, so served logos are always raster
-- formats.
ALTER TABLE platform_oauth_apps ADD COLUMN logo_key TEXT;

ALTER TABLE platform_oauth_apps ADD COLUMN logo_content_type TEXT;
