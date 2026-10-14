-- Approval bundles: one page an agent prefills with many pending approvals
-- (paused publishes, capability approvals, and recorded credential proposals)
-- across packages, for one person to review. Agents only create bundles; the
-- person approves or denies each item in the browser. Approving an item runs
-- the same code its own approval page runs.
--
-- `items_json` is the ordered list of item refs the agent picked. A bundle
-- only shows to `person_user_id` in `org_id`. `approval_bundle_decisions`
-- records each item's approve or deny, once.

CREATE TABLE approval_bundles (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	person_user_id TEXT NOT NULL,
	agent_credential_kind TEXT,
	agent_credential_id TEXT,
	note TEXT,
	items_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX approval_bundles_org_person_idx
	ON approval_bundles (org_id, person_user_id);

CREATE INDEX approval_bundles_person_user_idx
	ON approval_bundles (person_user_id);

CREATE TABLE approval_bundle_decisions (
	bundle_id TEXT NOT NULL,
	item_key TEXT NOT NULL,
	decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
	decided_by_user_id TEXT NOT NULL,
	decided_at TEXT NOT NULL,
	PRIMARY KEY (bundle_id, item_key),
	FOREIGN KEY (bundle_id) REFERENCES approval_bundles(id) ON DELETE CASCADE
);

CREATE INDEX approval_bundle_decisions_decided_by_idx
	ON approval_bundle_decisions (decided_by_user_id);
