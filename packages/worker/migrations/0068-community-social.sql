ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'private'));

ALTER TABLE saved_packages ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1));

CREATE TABLE user_follows (
	follower_user_id TEXT NOT NULL,
	followee_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (follower_user_id, followee_user_id)
);

CREATE INDEX idx_user_follows_followee_user_id
ON user_follows(followee_user_id);

CREATE TABLE community_stars (
	listing_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (listing_id, user_id)
);

CREATE INDEX idx_community_stars_user_id
ON community_stars(user_id);

CREATE TABLE community_activity_events (
	id TEXT PRIMARY KEY NOT NULL,
	actor_user_id TEXT NOT NULL,
	event_type TEXT NOT NULL CHECK (event_type IN ('listing_published', 'listing_updated')),
	listing_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_community_activity_events_actor_created
ON community_activity_events(actor_user_id, created_at);

CREATE INDEX idx_community_activity_events_listing_id
ON community_activity_events(listing_id);

INSERT INTO community_activity_events (id, actor_user_id, event_type, listing_id, created_at)
SELECT lower(hex(randomblob(16))), owner_user_id, 'listing_published', id, published_at
FROM community_listings;
