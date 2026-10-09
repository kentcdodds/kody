-- Package rename redirects keyed by slug (the leaf of `saved_packages.name`),
-- phase 1 of dropping `saved_packages.kody_id` (#1909).
--
-- Same shape as `package_kody_id_redirects` (0009): keyed by owner because
-- slugs are only unique per user, and by package id so a rename chain
-- (a -> b -> c) collapses onto the package's current slug. Writers dual-write
-- both tables and readers try this one first until the old table is dropped.

CREATE TABLE package_slug_redirects (
	user_id TEXT NOT NULL,
	old_slug TEXT NOT NULL,
	package_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	PRIMARY KEY (user_id, old_slug)
);

CREATE INDEX idx_package_slug_redirects_package_id
ON package_slug_redirects(package_id);

INSERT OR IGNORE INTO package_slug_redirects (user_id, old_slug, package_id, created_at)
SELECT user_id, old_kody_id, package_id, created_at
FROM package_kody_id_redirects;
