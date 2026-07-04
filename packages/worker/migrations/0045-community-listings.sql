CREATE TABLE community_listings (
	id TEXT PRIMARY KEY NOT NULL,
	owner_user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	kody_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	search_text TEXT,
	readme_content TEXT,
	license TEXT NOT NULL,
	pinned_commit TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted')),
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	published_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX idx_community_listings_owner_package
ON community_listings(owner_user_id, package_id);

CREATE INDEX idx_community_listings_status
ON community_listings(status);

CREATE TABLE community_forks (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	forker_user_id TEXT NOT NULL,
	origin_commit TEXT NOT NULL,
	forked_package_id TEXT NOT NULL,
	forked_source_id TEXT NOT NULL,
	target_kody_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_community_forks_listing_id
ON community_forks(listing_id);

CREATE INDEX idx_community_forks_forker_listing
ON community_forks(forker_user_id, listing_id);

CREATE TABLE community_ratings (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
	adaptation_effort INTEGER NOT NULL CHECK (adaptation_effort BETWEEN 1 AND 5),
	note TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX idx_community_ratings_listing_user
ON community_ratings(listing_id, user_id);

CREATE TABLE community_reports (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	listing_name TEXT NOT NULL,
	listing_owner_user_id TEXT NOT NULL,
	reporter_user_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
	resolved_by_user_id TEXT,
	resolved_at TEXT,
	resolution_note TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_community_reports_status
ON community_reports(status);

CREATE TABLE community_bans (
	user_id TEXT PRIMARY KEY NOT NULL,
	banned_by_user_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
