-- Canonical package URLs (`/@owner/kody-id`) resolve a listing from its owner
-- plus `kody.id` instead of the listing uuid, so that pair has to identify at
-- most one publicly reachable listing, and both halves have to survive a
-- rename.
--
-- Two active listings can already compete for one pair. Deleting a package
-- intentionally leaves its listing behind (the pinned snapshot outlives the
-- source), so an owner could delete a package and publish a new one reusing the
-- same `kody.id`; and because a listing's `kody_id` only moves on republish, an
-- owner could also edit one package's `kody.id` away and publish a second
-- package under the freed id, leaving two listings with live packages. Every
-- collision has to be resolved before the index exists, or creating it fails and
-- takes the deploy with it.
--
-- Keep exactly one listing per pair, preferring the strongest claim: a live
-- package that still uses the id, then any live package, then the most recently
-- updated listing (id as the final tiebreak so the choice is deterministic).
-- Delist the rest -- they stay readable by id for admin review, and public reads
-- already filter them out.
UPDATE community_listings
SET
	status = 'delisted',
	updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE status = 'active'
	AND id <> (
		SELECT keep.id
		FROM community_listings AS keep
		WHERE keep.owner_user_id = community_listings.owner_user_id
			AND keep.kody_id = community_listings.kody_id
			AND keep.status = 'active'
		ORDER BY
			EXISTS (
				SELECT 1
				FROM saved_packages
				WHERE saved_packages.id = keep.package_id
					AND saved_packages.user_id = keep.owner_user_id
					AND saved_packages.kody_id = keep.kody_id
			) DESC,
			EXISTS (
				SELECT 1
				FROM saved_packages
				WHERE saved_packages.id = keep.package_id
					AND saved_packages.user_id = keep.owner_user_id
			) DESC,
			keep.updated_at DESC,
			keep.id ASC
		LIMIT 1
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
