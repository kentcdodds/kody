-- Closed browse category for public community listings. Authors set
-- package.json#kody.category; publish stores the resolved value. Existing
-- rows stay `other` until republish, and reads still infer from tags when
-- the stored value is `other`.
ALTER TABLE community_listings
ADD COLUMN category TEXT NOT NULL DEFAULT 'other'
	CHECK (
		category IN (
			'integrations',
			'examples',
			'productivity',
			'apps',
			'utilities',
			'other'
		)
	);

CREATE INDEX idx_community_listings_category
ON community_listings(category);
