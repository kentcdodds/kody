CREATE TABLE community_forks_with_listing_snapshots (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	forker_user_id TEXT NOT NULL,
	origin_commit TEXT NOT NULL,
	forked_package_id TEXT NOT NULL,
	forked_source_id TEXT NOT NULL,
	target_kody_id TEXT NOT NULL,
	listing_name TEXT,
	listing_kody_id TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO community_forks_with_listing_snapshots (
	id,
	listing_id,
	forker_user_id,
	origin_commit,
	forked_package_id,
	forked_source_id,
	target_kody_id,
	listing_name,
	listing_kody_id,
	created_at
)
SELECT
	community_forks.id,
	community_forks.listing_id,
	community_forks.forker_user_id,
	community_forks.origin_commit,
	community_forks.forked_package_id,
	community_forks.forked_source_id,
	community_forks.target_kody_id,
	community_listings.name,
	community_listings.kody_id,
	community_forks.created_at
FROM community_forks
LEFT JOIN community_listings
	ON community_listings.id = community_forks.listing_id;

DROP TABLE community_forks;
ALTER TABLE community_forks_with_listing_snapshots RENAME TO community_forks;

CREATE INDEX idx_community_forks_listing_id
	ON community_forks(listing_id);
CREATE INDEX idx_community_forks_forker_listing
	ON community_forks(forker_user_id, listing_id);
