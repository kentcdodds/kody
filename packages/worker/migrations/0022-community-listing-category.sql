-- Closed browse category for public community listings. Authors set
-- package.json#kody.category; publish stores the resolved value. Existing
-- `other` rows are backfilled from the same well-known tag hints used at
-- publish time so SQL filters and chip counts match the stored column.
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

UPDATE community_listings
SET category = CASE
	WHEN EXISTS (
		SELECT 1 FROM json_each(community_listings.tags_json)
		WHERE lower(trim(json_each.value)) IN ('zero-auth', 'example', 'examples', 'starter')
	) THEN 'examples'
	WHEN EXISTS (
		SELECT 1 FROM json_each(community_listings.tags_json)
		WHERE lower(trim(json_each.value)) IN ('github', 'discord', 'spotify', 'notion', 'google', 'origin', 'slack', 'youtube', 'twitter', 'openai', 'stripe', 'linear', 'gmail', 'calendar', 'resend')
	) THEN 'integrations'
	WHEN EXISTS (
		SELECT 1 FROM json_each(community_listings.tags_json)
		WHERE lower(trim(json_each.value)) IN ('meal', 'grocery', 'planning', 'digest', 'rss', 'todo', 'notes')
	) THEN 'productivity'
	WHEN EXISTS (
		SELECT 1 FROM json_each(community_listings.tags_json)
		WHERE lower(trim(json_each.value)) IN ('app', 'apps')
	) THEN 'apps'
	ELSE category
END
WHERE category = 'other';
