-- Canonical package URLs (`/@owner/kody-id`) resolve a listing from its owner
-- plus `kody.id` instead of the listing uuid, so that pair has to identify at
-- most one publicly reachable listing, and both halves have to survive a
-- rename.
--
-- Deleting a package intentionally leaves its listing behind (the pinned
-- snapshot outlives the source), so an owner could delete a package and
-- publish a new one reusing the same `kody.id`, leaving two active listings
-- competing for one URL. Delist the orphaned side of any such collision -- the
-- listing whose package row is already gone -- so the live package keeps the
-- URL, then let a partial unique index hold the invariant going forward.
-- Delisted rows stay readable by id for admin review; public reads already
-- filter them out.
UPDATE community_listings
SET
	status = 'delisted',
	updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE status = 'active'
	AND NOT EXISTS (
		SELECT 1
		FROM saved_packages
		WHERE saved_packages.id = community_listings.package_id
			AND saved_packages.user_id = community_listings.owner_user_id
	)
	AND EXISTS (
		SELECT 1
		FROM community_listings AS competing
		WHERE competing.owner_user_id = community_listings.owner_user_id
			AND competing.kody_id = community_listings.kody_id
			AND competing.id <> community_listings.id
			AND competing.status = 'active'
	);

CREATE UNIQUE INDEX idx_community_listings_owner_kody_id_active
ON community_listings(owner_user_id, kody_id)
WHERE status = 'active';

-- A username change rewrites every package scope for that user, so it moves
-- every one of their canonical package URLs at once. Retain the old username so
-- links shared before the change keep resolving (to a redirect, not the page).
-- A live `users.username` always wins over a retained one, so reclaiming a
-- released username is not hijackable through this table.
CREATE TABLE username_redirects (
	-- SQLite quirk: plain TEXT PRIMARY KEY still allows NULL; be explicit.
	old_username TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_username_redirects_user_id
ON username_redirects(user_id);

-- The other half of the pair: `kody.id` is editable in the manifest, and
-- republishing under a new id moves the listing's URL the same way. Keyed by
-- owner because ids are only unique per user, and by package id so a rename
-- chain (a -> b -> c) collapses onto the package's current id.
CREATE TABLE package_kody_id_redirects (
	user_id TEXT NOT NULL,
	old_kody_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	PRIMARY KEY (user_id, old_kody_id)
);

CREATE INDEX idx_package_kody_id_redirects_package_id
ON package_kody_id_redirects(package_id);
