-- Repo-level visibility (default private). Public packages are the ones with
-- an active community listing; teaser `"private": false` packages stay private.
ALTER TABLE user_repos
	ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1));

UPDATE saved_packages SET is_private = 1;

UPDATE saved_packages
SET is_private = 0
WHERE id IN (
	SELECT package_id
	FROM community_listings
	WHERE status = 'active'
);
