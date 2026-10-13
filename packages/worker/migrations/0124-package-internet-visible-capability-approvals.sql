-- Internet-visible package apps (anonymous public serving) are independent of
-- forkable/public source visibility (`saved_packages.is_private`). Default 0
-- preserves today's session-gated app serving. Existing public packages stay
-- forkable (is_private = 0) and not internet-visible.
--
-- Approvals record the capability-set fingerprint the owner accepted before
-- serving on the public internet. Transitive dependency snapshots land in a
-- follow-up; this table stores an empty snapshot JSON until then.

ALTER TABLE saved_packages
	ADD COLUMN is_internet_visible INTEGER NOT NULL DEFAULT 0
	CHECK (is_internet_visible IN (0, 1));

CREATE TABLE package_capability_approvals (
	id TEXT PRIMARY KEY NOT NULL,
	package_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	published_commit TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	capability_set_json TEXT NOT NULL,
	dependency_snapshot_json TEXT NOT NULL DEFAULT '{}',
	approved_by_user_id TEXT NOT NULL,
	approved_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (package_id) REFERENCES saved_packages(id) ON DELETE CASCADE
);

CREATE INDEX package_capability_approvals_package_id_idx
	ON package_capability_approvals (package_id);

CREATE INDEX package_capability_approvals_package_fingerprint_idx
	ON package_capability_approvals (package_id, fingerprint);
