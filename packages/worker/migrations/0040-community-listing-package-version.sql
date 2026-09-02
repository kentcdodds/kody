-- Author-supplied package.json#version for catalog display. Null when the
-- author omitted it or the listing predates this column. Not a platform
-- versioning contract — listings stay identified by pinned_commit.
--
-- Rebuild instead of ADD COLUMN so this file is safe on preview D1s that
-- already applied the same column under the pre-rebase filename
-- 0039-community-listing-package-version.sql. Copy lists every live column
-- except package_version (NULL when the source table lacks it; preview
-- catalogs that already have the column are empty).
DROP TABLE IF EXISTS community_listings_0040;
CREATE TABLE community_listings_0040 (
	id TEXT PRIMARY KEY NOT NULL,
	owner_user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	kody_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	category TEXT NOT NULL DEFAULT 'other' CHECK (
		category IN (
			'integrations',
			'examples',
			'productivity',
			'apps',
			'utilities',
			'other'
		)
	),
	search_text TEXT,
	readme_content TEXT,
	license TEXT NOT NULL,
	package_version TEXT,
	pinned_commit TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted')),
	trusted_commit TEXT,
	trusted_by_user_id TEXT,
	trusted_at TEXT,
	featured_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	published_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
INSERT INTO community_listings_0040 (
	id, owner_user_id, package_id, source_id, kody_id, name, description,
	tags_json, category, search_text, readme_content, license, package_version,
	pinned_commit, status, trusted_commit, trusted_by_user_id, trusted_at,
	featured_at, created_at, updated_at, published_at
)
SELECT
	id, owner_user_id, package_id, source_id, kody_id, name, description,
	tags_json, category, search_text, readme_content, license, NULL,
	pinned_commit, status, trusted_commit, trusted_by_user_id, trusted_at,
	featured_at, created_at, updated_at, published_at
FROM community_listings;
DROP TABLE community_listings;
ALTER TABLE community_listings_0040 RENAME TO community_listings;
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_listings_owner_package
	ON community_listings(owner_user_id, package_id);
CREATE INDEX IF NOT EXISTS idx_community_listings_status
	ON community_listings(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_listings_owner_kody_id_active
	ON community_listings(owner_user_id, kody_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_community_listings_category
	ON community_listings(category);
