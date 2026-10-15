-- Follow any repo (phase 1). A follow is its own row: not a manifest entry
-- and not derived from forks at read time. Forking inserts one, and this
-- migration backfills follows for forks whose listing row still exists.
-- Forks whose listing was hard-deleted have no package id left to follow.

CREATE TABLE follows (
	id TEXT PRIMARY KEY NOT NULL,
	follower_org_id TEXT NOT NULL,
	creator_user_id TEXT NOT NULL,
	target_kind TEXT NOT NULL CHECK (target_kind IN ('package', 'repo')),
	target_owner_id TEXT NOT NULL,
	target_id TEXT NOT NULL,
	target_name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'paused')) DEFAULT 'active',
	paused_at TEXT,
	last_delivery_skip_reason TEXT,
	last_delivery_skip_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (follower_org_id, target_kind, target_id)
);

CREATE INDEX follows_target_idx
	ON follows (target_kind, target_id, status);

CREATE INDEX follows_paused_idx
	ON follows (status, paused_at);

CREATE INDEX follows_follower_idx
	ON follows (follower_org_id, created_at);

-- One open push window per target. The maintenance lane flushes a row once
-- window_started_at is at least five minutes old.
CREATE TABLE follow_push_pending (
	target_kind TEXT NOT NULL CHECK (target_kind IN ('package', 'repo')),
	target_id TEXT NOT NULL,
	window_started_at TEXT NOT NULL,
	before_commit TEXT,
	after_commit TEXT,
	ref TEXT NOT NULL,
	commits_json TEXT NOT NULL,
	total_commits_count INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (target_kind, target_id)
);

INSERT INTO follows (
	id,
	follower_org_id,
	creator_user_id,
	target_kind,
	target_owner_id,
	target_id,
	target_name,
	status,
	created_at,
	updated_at
)
SELECT
	'fork-' || community_forks.id,
	COALESCE(
		NULLIF(TRIM(users.personal_org_id), ''),
		community_forks.forker_user_id
	),
	community_forks.forker_user_id,
	'package',
	community_listings.owner_user_id,
	community_listings.package_id,
	community_listings.name,
	'active',
	community_forks.created_at,
	community_forks.created_at
FROM community_forks
INNER JOIN community_listings
	ON community_listings.id = community_forks.listing_id
LEFT JOIN users
	ON users.stable_user_id = community_forks.forker_user_id
WHERE community_listings.deleted_at IS NULL
	AND community_listings.package_id <> ''
	AND community_listings.name <> ''
ON CONFLICT (follower_org_id, target_kind, target_id) DO NOTHING;
