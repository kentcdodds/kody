ALTER TABLE community_forks ADD COLUMN listing_name TEXT;
ALTER TABLE community_forks ADD COLUMN listing_kody_id TEXT;

UPDATE community_forks
SET
	listing_name = (
		SELECT community_listings.name
		FROM community_listings
		WHERE community_listings.id = community_forks.listing_id
	),
	listing_kody_id = (
		SELECT community_listings.kody_id
		FROM community_listings
		WHERE community_listings.id = community_forks.listing_id
	);
