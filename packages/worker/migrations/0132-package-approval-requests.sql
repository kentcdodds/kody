-- One owner approval queue for published packages (ADR 0068 amendment,
-- ADR 0069). A publish that needs approval leaves the previously published
-- commit serving and records a pending request here; approving it publishes
-- `pending_commit`. `reason` says why: credential needs changed, or the
-- package went public (ADR 0069 PR3).
--
-- `base_commit` is the published commit when the request was made. A request
-- whose base no longer matches the published commit is stale and cannot be
-- approved. At most one request per package and reason is pending.

CREATE TABLE package_approval_requests (
	id TEXT PRIMARY KEY NOT NULL,
	package_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	reason TEXT NOT NULL
		CHECK (reason IN ('credential_needs_changed', 'went_public')),
	pending_commit TEXT NOT NULL,
	base_commit TEXT,
	details_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'approved', 'superseded')),
	requested_by_user_id TEXT,
	resolved_by_user_id TEXT,
	created_at TEXT NOT NULL,
	resolved_at TEXT,
	FOREIGN KEY (package_id) REFERENCES saved_packages(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX package_approval_requests_one_pending_idx
	ON package_approval_requests (package_id, reason)
	WHERE status = 'pending';

CREATE INDEX package_approval_requests_owner_idx
	ON package_approval_requests (owner_user_id, status);
